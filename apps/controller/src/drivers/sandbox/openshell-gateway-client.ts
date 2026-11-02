import {
  ADMISSION_LIMIT_DETAILS,
  OpenShellAdmissionLimitError,
  OpenShellDeletionUnconfirmedError,
  OpenShellGatewayFailure,
  OpenShellGatewayUnavailableError,
  GRPC_DEADLINE_EXCEEDED,
  GRPC_UNAVAILABLE,
  OpenShellProviderAlreadyExistsError,
  OpenShellRequestReplayRefusedError,
  OpenShellSandboxAlreadyExistsError,
  OpenShellWorkspaceAlreadyExistsError,
  REPLAY_REFUSAL_REASONS,
  openShellErrorReason,
  statusCode,
} from "./openshell-gateway-errors.ts";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import { DependencyUnavailableError, gatewayEndpointRewritesIpv4 } from "@openclaw-enterprise/occ";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { checkServerIdentity, connect as tlsConnect, createSecureContext } from "node:tls";
import { fileURLToPath } from "node:url";
import {
  getServiceDocument,
  postServiceDocument,
  serviceWebSocketHandshake,
  type OpenShellServiceDocument,
} from "./openshell-service-transport.ts";
import type {
  ChannelCredentials,
  Client,
  ClientReadableStream,
  ClientUnaryCall,
  Metadata,
  ServiceClientConstructor,
} from "@grpc/grpc-js";
import type { PackageDefinition } from "@grpc/proto-loader";

export {
  confirmSandboxAbsent,
  gatewayIdentityRefusal,
  OpenShellAdmissionLimitError,
  OpenShellProviderAlreadyExistsError,
  OpenShellRequestReplayRefusedError,
  OpenShellSandboxAlreadyExistsError,
  OpenShellWorkspaceAlreadyExistsError,
} from "./openshell-gateway-errors.ts";

type RecordValue = Readonly<Record<string, unknown>>;

export interface OpenShellGatewayClientOptions {
  readonly endpoint: string;
  readonly auth?:
    | { readonly mode: "unauthenticated" }
    | { readonly mode: "bearerTokenFile"; readonly path: string }
    | {
        readonly mode: "mtls" | "mutualTls";
        readonly certificatePath: string;
        readonly privateKeyPath: string;
      };
  readonly requestTimeoutMs?: number;
  /** Bounds one Sandbox deletion: the DeleteSandbox call plus any wait for its completion. */
  readonly sandboxDeleteTimeoutMs?: number;
  readonly rootCertificatePath?: string;
}

export interface OpenShellSandboxCreateRequest {
  readonly name: string;
  readonly workspace: string;
  readonly requestId: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly annotations: Readonly<Record<string, string>>;
  readonly spec: RecordValue;
  readonly serviceExposures: readonly {
    readonly service: string;
    readonly targetPort: number;
    readonly authorizationMode?: "strip" | "bearer_passthrough";
  }[];
}

/** Selects one Sandbox by name in a Workspace (GetSandbox, DeleteSandbox). */
export interface OpenShellSandboxDeleteRequest {
  readonly name: string;
  readonly workspace: string;
}

export interface OpenShellSandboxExecRequest {
  readonly workspace: string;
  readonly sandbox: string;
  readonly command: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  /** Private initialization material travels only on stdin, never in command arguments. */
  readonly stdin: string;
  readonly timeoutSeconds: number;
}

export interface OpenShellServiceRequest {
  readonly sandbox: string;
  readonly workspace: string;
  /** Empty selects the unnamed endpoint. */
  readonly service: string;
}

export interface OpenShellSandboxResponse {
  readonly resourceVersion?: string;
  readonly name: string;
  readonly id?: string;
  readonly workspace?: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly annotations: Readonly<Record<string, string>>;
  readonly spec?: Readonly<Record<string, unknown>>;
  readonly phase?: string | number;
  /** The Harness main process's last exit code, kept while the gateway restarts it. */
  readonly exitCode?: number;
  /** The gateway's restart number in the current crash loop; absent before any restart. */
  readonly restartCount?: number;
  /** Authenticated 0.1.5 supervisor configuration report, not evidence a request used it. */
  readonly configurationAdmission?: Readonly<Record<string, unknown>>;
  readonly mainProcessInstanceId?: string;
  readonly mainProcessStartedAt?: string;
  readonly serviceUrls: Readonly<Record<string, string>>;
}

export interface OpenShellServiceResponse {
  readonly sandbox: string;
  readonly name: string;
  readonly targetPort: number;
  readonly authorizationMode: string | number;
  /** URL advertised by OpenShell for workload traffic, before control-endpoint normalization. */
  readonly advertisedUrl: string;
  readonly url: string;
}

export interface OpenShellWorkspaceResponse {
  readonly name: string;
  readonly id?: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly phase?: string | number;
}

export interface OpenShellProviderProfileEndpoint {
  readonly host: string;
  readonly port: number;
  readonly protocol: string;
  readonly path?: string;
  readonly access?: "NETWORK_ACCESS_PRESET_FULL" | "NETWORK_ACCESS_PRESET_READ_WRITE";
  readonly rules?: readonly {
    readonly allow: { readonly method: string; readonly path: string };
  }[];
}

/** Exact stock endpoint sent at import and compared when the provider is observed. */
export function openShellProfileEndpoint(endpoint: OpenShellProviderProfileEndpoint) {
  const { rules, access = "NETWORK_ACCESS_PRESET_READ_WRITE", ...target } = endpoint;
  return {
    ...target,
    enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
    ...(rules ? { rules } : { access }),
  };
}

export type OpenShellRefreshStrategy =
  | "PROVIDER_CREDENTIAL_REFRESH_STRATEGY_OAUTH2_CLIENT_CREDENTIALS"
  | "PROVIDER_CREDENTIAL_REFRESH_STRATEGY_OAUTH2_REFRESH_TOKEN";

/** Gateway-owned refresh for one profile credential; the token endpoint lives only here. */
export interface OpenShellProfileCredentialRefresh {
  readonly strategy: OpenShellRefreshStrategy;
  readonly tokenUrl: string;
  readonly scopes: readonly string[];
  readonly refreshBeforeSeconds?: number;
  readonly material: readonly {
    readonly name: string;
    readonly required: boolean;
    readonly secret: boolean;
  }[];
}

/** The subset of an upstream ProviderProfile that OpenClaw Enterprise defines. */
export interface OpenShellProviderProfile {
  readonly id: string;
  readonly displayName: string;
  readonly category: "PROVIDER_PROFILE_CATEGORY_INFERENCE" | "PROVIDER_PROFILE_CATEGORY_OTHER";
  readonly credentials: readonly {
    readonly name: string;
    readonly envVars: readonly string[];
    readonly required: boolean;
    readonly authStyle: string;
    readonly headerName: string;
    readonly stablePlaceholder?: boolean;
    readonly refresh?: OpenShellProfileCredentialRefresh;
  }[];
  readonly files?: readonly {
    readonly path: string;
    readonly content: string;
    readonly environmentVariable: string;
  }[];
  readonly endpoints: readonly OpenShellProviderProfileEndpoint[];
  readonly binaries: readonly string[];
  readonly inferenceCapable: boolean;
  readonly annotations: Readonly<Record<string, string>>;
}

export interface OpenShellStoredProviderProfile {
  /** Non-secret profile definition for operator binding verification. */
  readonly definition?: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly resourceVersion: string;
  readonly annotations: Readonly<Record<string, string>>;
}

export interface OpenShellProviderCreateRequest {
  readonly workspace: string;
  readonly name: string;
  readonly type: string;
  readonly labels: Readonly<Record<string, string>>;
  /** Write-only material; never logged or returned by this client. */
  readonly credentials: Readonly<Record<string, string>>;
  /** RFC 3339 UTC expiry for each expiring credential environment variable. */
  readonly credentialExpirationTimes?: Readonly<Record<string, string>>;
  readonly config?: Readonly<Record<string, string>>;
}

export interface OpenShellProviderResponse {
  /** Update selection, not an exclusive-recipient precondition. */
  readonly targetReceipts?: readonly Record<string, unknown>[];
  readonly mutationId?: string;
  readonly id?: string;
  readonly workspace?: string;
  readonly profileWorkspace?: string;
  readonly name: string;
  readonly type: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly config: Readonly<Record<string, string>>;
  readonly resourceVersion: string;
}

export interface OpenShellRefreshConfigureRequest {
  readonly expirationTime?: string;
  readonly workspace: string;
  readonly provider: string;
  readonly credentialKey: string;
  readonly strategy: OpenShellRefreshStrategy;
  /** Write-only material; never logged or returned by this client. */
  readonly material: Readonly<Record<string, string>>;
  readonly requestId: string;
}

/** Gateway refresh state without token values or refresh material. */
export interface OpenShellRefreshStatus {
  readonly status: string;
  readonly expirationTime?: string;
  readonly nextRefreshTime?: string;
  readonly lastRefreshTime?: string;
  readonly recoveryAction?: string;
  readonly failureCode?: string;
}

export interface OpenShellProviderDesiredIdentity {
  readonly sandboxId: string;
  readonly sandbox: string;
  readonly attachmentEpoch: string;
  readonly providerId: string;
  readonly providerResourceVersion: string;
  readonly providerEnvRevision: string;
  readonly configRevision: string;
  readonly policyHash: string;
}

export interface OpenShellProviderReadinessObservation {
  readonly sessionId: string;
  readonly sequence: string;
  readonly attachmentEpoch: string;
  readonly providerEnvRevision: string;
  readonly configRevision: string;
  readonly policyHash: string;
  readonly credentialsInstalled: boolean;
  readonly policyActive: boolean;
  readonly launchEnvironmentInstalled: boolean;
  readonly processInstanceId: string;
  readonly reason: string;
}

export interface OpenShellSandboxProviderStatus {
  /** An already terminal receipt can be queried without creating or completing an operation. */
  readonly completedOperationId?: string;
  /** Terminal auxiliary OBSERVE history, never proof of installation or UPDATE completion. */
  readonly supersededObservationId?: string;
  readonly state: string;
  readonly reason?: string;
  readonly receipt?: {
    readonly receiptId?: string;
    readonly kind?: string;
    readonly provider: string;
    readonly workspace: string;
    readonly desired?: OpenShellProviderDesiredIdentity;
  };
  readonly observed?: OpenShellProviderReadinessObservation;
  readonly networkInstanceId?: string;
  readonly observedTime?: string;
  readonly evaluatedTime?: string;
}

/** Readiness for a detach, including a replay of one, is read through its receipt. */
export interface OpenShellProviderDetachResult {
  readonly detached?: boolean;
  readonly receiptId?: string;
}

export interface OpenShellSandboxLogsRequest {
  readonly workspace: string;
  readonly sandbox: string;
  /** 1 to 2000; the gateway ring holds at most 2000 lines per sandbox. */
  readonly lines: number;
  /** RFC 3339; only lines at or after this time. */
  readonly sinceTime?: string;
}

export interface OpenShellSandboxLogLine {
  readonly sandboxId: string;
  readonly time: string | null;
  readonly level: string;
  readonly target: string;
  readonly message: string;
  readonly source: string;
  readonly fields: Readonly<Record<string, string>>;
}

export interface OpenShellSandboxLogsResponse {
  readonly lines: readonly OpenShellSandboxLogLine[];
  /** Lines the gateway examined before the time filter (at most `lines`). */
  readonly bufferTotal: number;
}

/**
 * The only OpenShell surface the runtime log path holds: one read-only RPC
 * (`GetSandboxLogs`, upstream scope `sandbox:read`). It cannot create, delete or
 * exec into a Sandbox; see `openShellSandboxLogReader`.
 */
export interface OpenShellSandboxLogReader {
  getSandboxLogs(
    request: OpenShellSandboxLogsRequest,
    signal: AbortSignal,
  ): Promise<OpenShellSandboxLogsResponse>;
}

/** Narrows a gateway client to its log read; the result exposes nothing else. */
export function openShellSandboxLogReader(
  client: OpenShellSandboxLogReader,
): OpenShellSandboxLogReader {
  const read = client.getSandboxLogs.bind(client);
  return Object.freeze({
    getSandboxLogs: (request: OpenShellSandboxLogsRequest, signal: AbortSignal) =>
      read(request, signal),
  });
}

export interface OpenShellSandboxObserver {
  getSandbox(
    request: OpenShellSandboxDeleteRequest,
    signal: AbortSignal,
  ): Promise<OpenShellSandboxResponse | undefined>;
}

/** Narrows a gateway client to its Sandbox record read; the result exposes nothing else. */
export function openShellSandboxObserver(
  client: OpenShellSandboxObserver,
): OpenShellSandboxObserver {
  const read = client.getSandbox.bind(client);
  return Object.freeze({
    getSandbox: (request: OpenShellSandboxDeleteRequest, signal: AbortSignal) =>
      read(request, signal),
  });
}

export interface OpenShellPolicyRequest {
  readonly workspace: string;
  readonly sandbox: string;
}
export interface OpenShellPolicyStatus {
  readonly version: number;
  readonly activeVersion: number;
  readonly state: string;
  readonly policy: Readonly<Record<string, unknown>>;
}

export interface OpenShellGatewayClient
  extends OpenShellSandboxLogReader, OpenShellSandboxObserver {
  getPolicyStatus?(
    request: OpenShellPolicyRequest,
    signal: AbortSignal,
  ): Promise<OpenShellPolicyStatus>;
  updatePolicy?(
    request: OpenShellPolicyRequest & {
      readonly policy: Readonly<Record<string, unknown>>;
      readonly expectedResourceVersion: string;
      readonly requestId: string;
    },
    signal: AbortSignal,
  ): Promise<void>;
  getPolicyDrafts?(
    request: OpenShellPolicyRequest,
    signal: AbortSignal,
  ): Promise<{
    readonly chunks: readonly Readonly<Record<string, unknown>>[];
    readonly version: string;
  }>;
  health(signal: AbortSignal): Promise<void>;
  getGatewayInfo?(signal: AbortSignal): Promise<RecordValue>;
  /** Stock preview reads. The operator independently controls gateway access and every writer. */
  readExclusivePreviewWorkspace?(
    workspace: string,
    sandboxId: string,
    signal: AbortSignal,
  ): Promise<boolean>;
  getSandboxConfig?(workspace: string, sandbox: string, signal: AbortSignal): Promise<RecordValue>;
  getSandboxPolicyStatus?(
    workspace: string,
    sandbox: string,
    signal: AbortSignal,
  ): Promise<RecordValue>;
  getWorkspace(name: string, signal: AbortSignal): Promise<OpenShellWorkspaceResponse | undefined>;
  createWorkspace(
    name: string,
    labels: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<OpenShellWorkspaceResponse>;
  deleteWorkspace(name: string, signal: AbortSignal): Promise<void>;
  createSandbox(
    request: OpenShellSandboxCreateRequest,
    signal: AbortSignal,
  ): Promise<OpenShellSandboxResponse>;
  /** Undefined when the Sandbox does not exist. Service URLs are always empty. */
  getSandbox(
    request: OpenShellSandboxDeleteRequest,
    signal: AbortSignal,
  ): Promise<OpenShellSandboxResponse | undefined>;
  /** The exposed service's URL, or undefined when the endpoint does not exist. */
  getServiceUrl(request: OpenShellServiceRequest, signal: AbortSignal): Promise<string | undefined>;
  getService(
    workspace: string,
    sandbox: string,
    name: string,
    signal: AbortSignal,
  ): Promise<OpenShellServiceResponse | undefined>;
  /**
   * Removes one exposed service endpoint. Resolves only once OpenShell confirms the endpoint
   * gone (COMPLETED or ALREADY_ABSENT); any other answer is a failure. NOT_FOUND is one too: it
   * names a Sandbox that is gone or that this identity may not see (OpenShell answers both
   * alike), so it confirms nothing about the endpoint.
   */
  deleteService(
    workspace: string,
    sandbox: string,
    name: string,
    signal: AbortSignal,
  ): Promise<void>;
  /**
   * Removes one Sandbox. Resolves only once OpenShell confirms it gone; NOT_FOUND is a failure,
   * since it names a Sandbox that is gone or that this identity may not see (OpenShell answers
   * both alike), so it confirms nothing. Callers read first and confirm an absent Sandbox with
   * `confirmSandboxAbsent`.
   */
  deleteSandbox(request: OpenShellSandboxDeleteRequest, signal: AbortSignal): Promise<void>;
  /** Discards process output and returns its exit code only after the stream completes. */
  execSandbox(request: OpenShellSandboxExecRequest, signal: AbortSignal): Promise<number>;
  /** One bounded GET to a bearer-passthrough service path, through the gateway listener. */
  getServiceDocument(
    serviceUrl: string,
    path: string,
    bearer: string,
    signal: AbortSignal,
  ): Promise<OpenShellServiceDocument>;
  postServiceDocument(
    serviceUrl: string,
    path: string,
    bearer: string,
    body: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<OpenShellServiceDocument>;
  /** True when the service completes an authenticated WebSocket handshake. */
  serviceWebSocketHandshake(
    serviceUrl: string,
    bearer: string,
    signal: AbortSignal,
  ): Promise<boolean>;
  /** Read a profile in its Workspace, or pass null to request the platform profile. */
  getProviderProfile(
    workspace: string | null,
    id: string,
    signal: AbortSignal,
  ): Promise<OpenShellStoredProviderProfile | undefined>;
  importProviderProfile(
    workspace: string,
    profile: OpenShellProviderProfile,
    signal: AbortSignal,
  ): Promise<void>;
  updateProviderProfile(
    workspace: string,
    profile: OpenShellProviderProfile,
    expectedResourceVersion: string,
    signal: AbortSignal,
  ): Promise<void>;
  /** Every profile the Workspace resolves, platform and static profiles included. */
  listProviderProfiles(
    workspace: string,
    signal: AbortSignal,
  ): Promise<readonly OpenShellStoredProviderProfile[]>;
  deleteProviderProfile(workspace: string, id: string, signal: AbortSignal): Promise<void>;
  createProvider(
    request: OpenShellProviderCreateRequest,
    signal: AbortSignal,
  ): Promise<OpenShellProviderResponse>;
  getProvider(
    workspace: string,
    name: string,
    signal: AbortSignal,
  ): Promise<OpenShellProviderResponse | undefined>;
  listProviders(
    workspace: string,
    signal: AbortSignal,
  ): Promise<readonly OpenShellProviderResponse[]>;
  deleteProvider(workspace: string, name: string, signal: AbortSignal): Promise<void>;
  /** Merges the given credential values into an existing provider. */
  updateProviderCredentials(
    workspace: string,
    name: string,
    credentials: Readonly<Record<string, string>>,
    signal: AbortSignal,
    credentialExpirationTimes?: Readonly<Record<string, string>>,
  ): Promise<void>;
  /** Static credential rotation, conditional on the previously observed provider version. */
  updateProviderCredentialsConditionally?(
    request: OpenShellProviderCreateRequest,
    expectedResourceVersion: string,
    signal: AbortSignal,
  ): Promise<OpenShellProviderResponse>;
  /** Merges nonempty configuration into an existing provider with optimistic concurrency. */
  updateProviderConfig(
    workspace: string,
    name: string,
    config: Readonly<Record<string, string>>,
    expectedResourceVersion: string,
    signal: AbortSignal,
  ): Promise<OpenShellProviderResponse>;
  /** Returns one runtime credential; OpenShell refreshes it when needed. */
  getProviderCredential(
    workspace: string,
    provider: string,
    credentialKey: string,
    signal: AbortSignal,
  ): Promise<{ readonly value: string; readonly expirationTime?: string }>;
  /** Undefined when the Sandbox no longer exists, so nothing remains to revoke. */
  detachSandboxProvider(
    workspace: string,
    sandbox: string,
    provider: string,
    signal: AbortSignal,
    conditional?: { readonly expectedResourceVersion: string; readonly requestId: string },
  ): Promise<OpenShellProviderDetachResult | undefined>;
  getSandboxProviderStatus(
    workspace: string,
    sandbox: string,
    provider: string,
    signal: AbortSignal,
    receiptId?: string,
  ): Promise<OpenShellSandboxProviderStatus>;
  configureProviderRefresh(
    request: OpenShellRefreshConfigureRequest,
    signal: AbortSignal,
  ): Promise<OpenShellRefreshStatus>;
  rotateProviderCredential(
    workspace: string,
    provider: string,
    credentialKey: string,
    requestId: string,
    signal: AbortSignal,
  ): Promise<OpenShellRefreshStatus>;
  /** Undefined when the provider or its refresh state does not exist. */
  getProviderRefreshStatus(
    workspace: string,
    provider: string,
    credentialKey: string,
    signal: AbortSignal,
  ): Promise<OpenShellRefreshStatus | undefined>;
  /** Idempotent; an absent provider or refresh state counts as removed. */
  deleteProviderRefresh(
    workspace: string,
    provider: string,
    credentialKey: string,
    signal: AbortSignal,
  ): Promise<void>;
  close(): void;
}

type OpenShellMethod =
  | "GetSandboxConfig"
  | "ListSandboxes"
  | "ListWorkspaceMembers"
  | "GetSandboxPolicyStatus"
  | "UpdateConfig"
  | "GetDraftPolicy"
  | "ConfigureProviderRefresh"
  | "RotateProviderCredential"
  | "GetProviderRefreshStatus"
  | "GetProviderCredentials"
  | "Health"
  | "GetGatewayInfo"
  | "GetSandboxPolicyStatus"
  | "GetWorkspace"
  | "CreateWorkspace"
  | "DeleteWorkspace"
  | "CreateSandbox"
  | "GetSandbox"
  | "GetService"
  | "DeleteService"
  | "DeleteSandbox"
  | "GetSandboxLogs"
  | "GetSandboxProviderStatus"
  | "CreateProvider"
  | "UpdateProvider"
  | "DetachSandboxProvider"
  | "GetProvider"
  | "ListProviders"
  | "DeleteProvider"
  | "GetProviderProfile"
  | "ListProviderProfiles"
  | "ImportProviderProfiles"
  | "UpdateProviderProfiles"
  | "DeleteProviderProfile"
  | "DeleteProviderRefresh";

type OpenShellUnaryMethod = (
  request: RecordValue,
  metadata: Metadata,
  options: { deadline: Date },
  callback: (error: Error | null, response?: RecordValue) => void,
) => ClientUnaryCall;

type OpenShellGrpcClient = Client &
  Record<OpenShellMethod, OpenShellUnaryMethod> & {
    ExecSandbox(
      request: RecordValue,
      metadata: Metadata,
      options: { deadline: Date },
    ): ClientReadableStream<RecordValue>;
  };

/** A failed gateway request's message: the method, its gRPC status, and only a safe detail. */
function gatewayRequestFailureMessage(
  method: OpenShellMethod | "ExecSandbox",
  error: unknown,
): string {
  const grpcStatus = rawStatusCode(error);
  // A failure without a gRPC status (a local client error) keeps only its class: its message
  // can be any library text, and the API logs this message for a 503 (http.dependency_unavailable).
  const detail =
    grpcStatus === undefined &&
    error instanceof Error &&
    /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(error.name)
      ? error.name
      : undefined;
  return `OpenShell ${method} failed${
    grpcStatus === undefined ? "" : ` with gRPC status ${grpcStatus}`
  }${detail === undefined ? "." : `: ${detail}`}`;
}

class OpenShellGatewayRequestFailure extends DependencyUnavailableError {
  readonly grpcStatus: number | undefined;

  constructor(method: OpenShellMethod | "ExecSandbox", error: unknown) {
    const grpcStatus = rawStatusCode(error);
    super(
      gatewayRequestFailureMessage(method, error),
      grpcStatus === undefined
        ? undefined
        : {
            method,
            grpcStatus,
            validationCategory: createSandboxValidationCategory(method, grpcStatus, error),
          },
    );
    this.grpcStatus = grpcStatus;
  }
}

function createSandboxValidationCategory(
  method: OpenShellMethod | "ExecSandbox",
  grpcStatus: number,
  error: unknown,
): NonNullable<DependencyUnavailableError["requestDiagnostic"]>["validationCategory"] {
  const details = asRecord(error)?.details;
  // Pinned supplier 246bac67400487c03595f7d883dd2b5256f4baf0:
  // grpc/validation.rs and middleware.rs wrap CreateSandbox policy errors with these exact
  // prefixes. Do not normalize text or match embedded prefixes: other validation stays unknown.
  if (method !== "CreateSandbox" || grpcStatus !== 3 || typeof details !== "string") {
    return "UNKNOWN";
  }
  if (details.startsWith("policy contains unsafe content: ")) {
    return "POLICY_SAFETY";
  }
  if (details.startsWith("policy middleware validation failed: ")) {
    return "POLICY_MIDDLEWARE_VALIDATION";
  }
  return "UNKNOWN";
}

// gRPC UNAVAILABLE says two different things. grpc-js makes it up, with these fixed details,
// when it never reached the gateway or lost the connection under a call: the gateway did not
// answer. The gateway also sends UNAVAILABLE itself, with its own reason, for failures that do
// not clear by themselves (at the pinned OpenShell, resource admission's Kubernetes 401/403/TLS
// errors, credential driver errors, finding 2042), and a gateway interceptor sends any reason it
// chooses with the status it chooses (finding 2048). Only the first is an outage. The list is an
// allowlist on purpose: anything else, including a TLS failure (an untrusted gateway certificate,
// a refused client certificate, a connection closed during the handshake), a connection closed
// before HTTP/2 starts ("Failed to connect": a plaintext client at a TLS port reads the same as
// a stale port-forward, finding 2049) and an HTTP status or gRPC reply from a proxy in front of
// the gateway, is an ordinary failed request on the attempt budget.
const UNANSWERED_REQUESTS: readonly (readonly [code: number, details: RegExp])[] = [
  // The connection closed or was reset under an in-flight call (the gateway process is gone).
  [GRPC_UNAVAILABLE, /^Connection dropped$/u],
  [GRPC_UNAVAILABLE, /^(?:read|write) (?:ECONNRESET|ETIMEDOUT)$/u],
  // The gateway refused the stream before handling it (shutting down, or at its stream limit).
  [GRPC_UNAVAILABLE, /^Stream refused by server$/u],
  // No address for the gateway, or no connection to it: nothing listens there. grpc-js's DNS
  // lookup rejects a name without addresses, so "No addresses resolved" never occurs here.
  [GRPC_UNAVAILABLE, /^Name resolution failed for target /u],
  [
    GRPC_UNAVAILABLE,
    /^No connection established\. Last error: (?:Error: )?(?:connect (?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT)|(?:read|write) (?:ECONNRESET|ETIMEDOUT|EPIPE))\b/u,
  ],
  // The deadline passed while grpc-js still had no connection to send the request on: a connect
  // nobody answers (a lost node, a stale Service address) or a listener that never starts HTTP/2.
  [
    GRPC_DEADLINE_EXCEEDED,
    /^Deadline exceeded after \d+\.\d{3}s(?:,[a-z ]+: \d+\.\d{3}s)*,Waiting for LB pick$/u,
  ],
];

/**
 * grpc-js gives a status it makes up itself empty metadata. A status the gateway sends before
 * any response message is the whole response in one HEADERS frame (tonic answers interceptor
 * refusals and handler errors that way), whose other headers stay as metadata (content-type,
 * date). Only a status in trailers after response headers, such as an error in the middle of
 * an ExecSandbox stream, can carry none; there the details alone decide.
 */
function noServerMetadata(error: unknown): boolean {
  const metadata = asRecord(asRecord(error)?.metadata);
  const getMap = metadata?.getMap;
  return (
    typeof getMap === "function" && Object.keys(asRecord(getMap.call(metadata)) ?? {}).length === 0
  );
}

/** True only for grpc-js's own status for a gateway that did not answer (findings 2042, 2048). */
function gatewayDidNotAnswer(error: unknown): boolean {
  const code = rawStatusCode(error);
  const details = asRecord(error)?.details;
  return (
    typeof details === "string" &&
    noServerMetadata(error) &&
    UNANSWERED_REQUESTS.some(([status, pattern]) => status === code && pattern.test(details))
  );
}

function gatewayRequestFailure(
  method: OpenShellMethod | "ExecSandbox",
  error: unknown,
  unanswered: boolean = gatewayDidNotAnswer(error),
): OpenShellGatewayRequestFailure | OpenShellGatewayUnavailableError {
  const grpcStatus = rawStatusCode(error);
  return unanswered && grpcStatus !== undefined
    ? new OpenShellGatewayUnavailableError(gatewayRequestFailureMessage(method, error), grpcStatus)
    : new OpenShellGatewayRequestFailure(method, error);
}
const CLIENT_MODULE = "@grpc/grpc-js";
const LOADER_MODULE = "@grpc/proto-loader";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
// At the pinned OpenShell revision, DeleteSandbox answers only after the Kubernetes driver
// has watched the Sandbox Pod go (a 30 s termination grace plus a 30 s Kubernetes API
// timeout, around list, delete and get calls of up to 30 s each). A running Sandbox takes
// about 30 s, so the ordinary request deadline (at most 30 s) expired on every redeploy and
// the worker retried the whole prepare pass (finding 857). 120 s covers that with headroom;
// a rarer longer run fails this attempt, and OpenShell's delete keeps going regardless of
// the client, so the retry sees ACCEPTED or NOT_FOUND.
const DEFAULT_SANDBOX_DELETE_TIMEOUT_MS = 120_000;
const SANDBOX_DELETE_POLL_INTERVAL_MS = 500;

function nonempty(value: unknown, description: string): string {
  if (!isNonEmptyString(value)) {
    throw new OpenShellGatewayFailure(`${description} must be a nonempty string.`);
  }
  return value;
}

function deadline(timeoutMs: number): Date {
  return new Date(Date.now() + timeoutMs);
}

function rawStatusCode(error: unknown): number | undefined {
  const candidate = asRecord(error)?.code;
  return typeof candidate === "number" &&
    Number.isInteger(candidate) &&
    candidate >= 0 &&
    candidate <= 16
    ? candidate
    : undefined;
}

function workspaceResponse(response: RecordValue, operation: string): OpenShellWorkspaceResponse {
  const workspace = asRecord(response.workspace);
  const metadata = asRecord(workspace?.metadata);
  const name = metadata?.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new OpenShellGatewayFailure(`OpenShell ${operation} returned no stable Workspace name.`);
  }
  const workspaceLabels = asRecord(metadata?.labels) ?? {};
  if (Object.values(workspaceLabels).some((value) => typeof value !== "string")) {
    throw new OpenShellGatewayFailure(`OpenShell ${operation} returned invalid Workspace labels.`);
  }
  return Object.freeze({
    name,
    ...(typeof metadata?.id === "string" && metadata.id.length > 0 ? { id: metadata.id } : {}),
    labels: Object.freeze({ ...(workspaceLabels as Record<string, string>) }),
    ...(asRecord(workspace?.status)?.phase === undefined
      ? {}
      : { phase: asRecord(workspace?.status)?.phase as string | number }),
  });
}

function stringMap(value: unknown, description: string): Readonly<Record<string, string>> {
  const record = asRecord(value) ?? {};
  if (Object.values(record).some((entry) => typeof entry !== "string")) {
    throw new OpenShellGatewayFailure(`OpenShell ${description} must be a string map.`);
  }
  return Object.freeze({ ...(record as Record<string, string>) });
}

function storedProviderProfile(profile: RecordValue, id: string): OpenShellStoredProviderProfile {
  return Object.freeze({
    id,
    definition: Object.freeze({ ...profile }),
    resourceVersion: String(profile.resource_version ?? "0"),
    annotations: stringMap(profile.annotations, "profile annotations"),
  });
}

function providerResponse(value: unknown, operation: string): OpenShellProviderResponse {
  const provider = asRecord(value);
  const metadata = asRecord(provider?.metadata);
  const name = metadata?.name;
  const resourceVersion = String(metadata?.resource_version ?? "0");
  if (
    typeof name !== "string" ||
    name.trim().length === 0 ||
    typeof provider?.type !== "string" ||
    !/^\d+$/u.test(resourceVersion)
  ) {
    throw new OpenShellGatewayFailure(`OpenShell ${operation} returned no stable provider.`);
  }
  // Credential values are never copied out of gateway responses.
  return Object.freeze({
    name,
    ...(typeof metadata?.id === "string" ? { id: metadata.id } : {}),
    ...(typeof metadata?.workspace === "string" ? { workspace: metadata.workspace } : {}),
    ...(typeof provider.profile_workspace === "string"
      ? { profileWorkspace: provider.profile_workspace }
      : {}),
    type: provider.type,
    labels: stringMap(metadata?.labels, "provider labels"),
    config: stringMap(provider?.config, "provider config"),
    resourceVersion,
  });
}

function profileMessage(profile: OpenShellProviderProfile): RecordValue {
  return {
    id: profile.id,
    display_name: profile.displayName,
    category: profile.category,
    credentials: profile.credentials.map((credential) => ({
      name: credential.name,
      env_vars: [...credential.envVars],
      required: credential.required,
      auth_style: credential.authStyle,
      header_name: credential.headerName,
      ...(credential.stablePlaceholder === undefined
        ? {}
        : { stable_placeholder: credential.stablePlaceholder }),
      ...(credential.refresh === undefined
        ? {}
        : {
            refresh: {
              strategy: credential.refresh.strategy,
              token_url: credential.refresh.tokenUrl,
              ...(credential.refresh.refreshBeforeSeconds === undefined
                ? {}
                : {
                    refresh_before: { seconds: credential.refresh.refreshBeforeSeconds, nanos: 0 },
                  }),
              scopes: [...credential.refresh.scopes],
              material: credential.refresh.material.map((item) => ({
                name: item.name,
                required: item.required,
                secret: item.secret,
              })),
            },
          }),
    })),
    files: (profile.files ?? []).map((file) => ({
      path: file.path,
      content: file.content,
      env_var: file.environmentVariable,
    })),
    endpoints: profile.endpoints.map(openShellProfileEndpoint),
    binaries: profile.binaries.map((path) => ({ path })),
    inference_capable: profile.inferenceCapable,
    annotations: { ...profile.annotations },
  };
}

function profileDiagnosticsFailure(response: RecordValue, operation: string): void {
  const diagnostics = Array.isArray(response.diagnostics) ? response.diagnostics : [];
  const errors = diagnostics
    .map((entry) => asRecord(entry))
    .filter((entry) => entry?.severity === "error");
  if (errors.length > 0) {
    const detail = errors
      .map((entry) => `${String(entry?.field ?? "profile")}: ${String(entry?.message ?? "")}`)
      .join("; ");
    throw new OpenShellGatewayFailure(`OpenShell ${operation} rejected the profile: ${detail}`);
  }
}

const MAX_SANDBOX_LOG_LINES = 2000;
/**
 * The largest response message the client accepts, after decompression: the grpc-js
 * default, pinned because it is what bounds `GetSandboxLogs`. OpenShell does not limit
 * a log line's length, so a read (up to 2000 lines; OCC asks for at most 1000) is
 * buffered whole before OCC withholds oversized lines. A larger response fails the
 * read with `RESOURCE_EXHAUSTED` instead of being cut.
 * grpc-js has no per-call limit, and every other RPC already had this one.
 */
const MAX_RECEIVE_MESSAGE_BYTES = 4 * 1024 * 1024;

/** RFC 3339 with up to nanosecond precision to a protobuf Timestamp. */
function timestampMessage(value: string): { seconds: string; nanos: number } {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  const seconds = match === null ? Number.NaN : Date.parse(`${match[1]}Z`);
  if (
    match === null ||
    Number.isNaN(seconds) ||
    new Date(seconds).toISOString().slice(0, 19) !== match[1]
  ) {
    throw new OpenShellGatewayFailure("OpenShell timestamp must be an RFC 3339 UTC time.");
  }
  return {
    seconds: String(Math.floor(seconds / 1000)),
    nanos: Number((match[2] ?? "").padEnd(9, "0")),
  };
}

/** A protobuf Timestamp to RFC 3339 with nanosecond precision, or null when absent. */
function timestampText(value: unknown): string | null {
  const timestamp = asRecord(value);
  if (timestamp === undefined) {
    return null;
  }
  const seconds = Number(timestamp.seconds ?? 0);
  const nanos = Number(timestamp.nanos ?? 0);
  if (
    !Number.isSafeInteger(seconds) ||
    !Number.isSafeInteger(nanos) ||
    nanos < 0 ||
    nanos > 999_999_999
  ) {
    return null;
  }
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() > 9999 || seconds < 0) {
    return null;
  }
  return `${date.toISOString().slice(0, 19)}.${String(nanos).padStart(9, "0")}Z`;
}

function refreshStatus(value: unknown, operation: string): OpenShellRefreshStatus {
  const status = asRecord(value);
  if (typeof status?.status !== "string" || status.status.length === 0) {
    throw new OpenShellGatewayFailure(`OpenShell ${operation} returned no refresh status.`);
  }
  const time = (field: unknown) => timestampText(field) ?? undefined;
  const expirationTime = time(status.expiration_time);
  const nextRefreshTime = time(status.next_refresh_time);
  const lastRefreshTime = time(status.last_refresh_time);
  return Object.freeze({
    status: status.status,
    ...(expirationTime === undefined ? {} : { expirationTime }),
    ...(nextRefreshTime === undefined ? {} : { nextRefreshTime }),
    ...(lastRefreshTime === undefined ? {} : { lastRefreshTime }),
    ...(typeof status.recovery_action === "string"
      ? { recoveryAction: status.recovery_action }
      : {}),
    ...(isNonEmptyString(status.failure_code) ? { failureCode: status.failure_code } : {}),
  });
}

function sandboxLogLine(value: unknown): OpenShellSandboxLogLine {
  const line = asRecord(value) ?? {};
  const text = (entry: unknown) => (typeof entry === "string" ? entry : "");
  return Object.freeze({
    sandboxId: text(line.sandbox_id),
    time: timestampText(line.event_time),
    level: text(line.level),
    target: text(line.target),
    message: text(line.message),
    source: text(line.source),
    fields: stringMap(line.fields, "sandbox log fields"),
  });
}

function deletionConfirmed(response: RecordValue): boolean {
  return ["DELETION_OUTCOME_COMPLETED", "DELETION_OUTCOME_ALREADY_ABSENT", 1, 3].includes(
    response.outcome as string | number,
  );
}

function normalizeEndpoint(endpoint: string): {
  readonly target: string;
  readonly secure: boolean;
} {
  const value = nonempty(endpoint, "OpenShell gateway endpoint");
  if (gatewayEndpointRewritesIpv4(value)) {
    throw new OpenShellGatewayFailure(
      "OpenShell gateway endpoint IPv4 host must be four decimal octets from 0 to 255 with no leading zeros; other spellings parse as a different address.",
    );
  }
  if (!value.includes("://")) {
    return { target: value, secure: false };
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new OpenShellGatewayFailure("OpenShell gateway endpoint is not a valid URL.");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new OpenShellGatewayFailure(
      "OpenShell gateway endpoint must not include credentials, path, query, or fragment.",
    );
  }
  if (parsed.protocol === "http:") {
    return { target: `${parsed.hostname}:${parsed.port || "80"}`, secure: false };
  }
  if (parsed.protocol === "https:") {
    return { target: parsed.host, secure: true };
  }
  throw new OpenShellGatewayFailure("OpenShell gateway endpoint must use http or https.");
}

function serviceUrl(value: unknown): URL {
  let serviceUrl: URL;
  try {
    serviceUrl = new URL(nonempty(value, "OpenShell service URL"));
  } catch {
    throw new OpenShellGatewayFailure("OpenShell service URL must be a valid URL.");
  }
  if (
    (serviceUrl.protocol !== "http:" && serviceUrl.protocol !== "https:") ||
    serviceUrl.username.length > 0 ||
    serviceUrl.password.length > 0 ||
    serviceUrl.pathname !== "/" ||
    serviceUrl.search.length > 0 ||
    serviceUrl.hash.length > 0
  ) {
    throw new OpenShellGatewayFailure(
      "OpenShell service URL must be an HTTP origin without credentials, query, or fragment.",
    );
  }
  return serviceUrl;
}

export function normalizeServiceUrl(value: unknown, endpoint: string): string {
  const normalized = serviceUrl(value);
  const gateway = normalizeEndpoint(endpoint);
  const gatewayUrl = new URL(`${gateway.secure ? "https" : "http"}://${gateway.target}`);
  normalized.port = gatewayUrl.port;
  return normalized.toString();
}

function sandboxResponse(
  response: RecordValue,
  operation: string,
  endpoint: string,
  requireServiceUrls: boolean,
): OpenShellSandboxResponse {
  const sandbox = asRecord(response.sandbox);
  const metadata = asRecord(sandbox?.metadata);
  const name = metadata?.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new OpenShellGatewayFailure(`OpenShell ${operation} returned no stable name.`);
  }
  const serviceUrls = asRecord(response.service_urls);
  if (serviceUrls === undefined && requireServiceUrls) {
    throw new OpenShellGatewayFailure(`OpenShell ${operation} returned no service URL map.`);
  }
  const spec = asRecord(sandbox?.spec);
  const status = asRecord(sandbox?.status);
  // Gateway-owned restart state (pinned gateway SandboxStatus fields 9 and 14).
  const exitCode = status?.exit_code;
  const restartCount = status?.restart_count;
  return Object.freeze({
    name,
    ...(metadata?.resource_version === undefined
      ? {}
      : { resourceVersion: String(metadata.resource_version) }),
    ...(typeof metadata?.id === "string" && metadata.id.length > 0 ? { id: metadata.id } : {}),
    ...(typeof metadata?.workspace === "string" && metadata.workspace.length > 0
      ? { workspace: metadata.workspace }
      : {}),
    labels: stringMap(metadata?.labels, "Sandbox labels"),
    annotations: stringMap(metadata?.annotations, "Sandbox annotations"),
    ...(spec === undefined ? {} : { spec: Object.freeze({ ...spec }) }),
    ...(status?.configuration_activated === true &&
      asRecord(status.configuration_admission) && {
        configurationAdmission: asRecord(status.configuration_admission)!,
        mainProcessInstanceId:
          typeof status.main_process_instance_id === "string"
            ? status.main_process_instance_id
            : "",
        mainProcessStartedAt: timestampText(status.main_process_started_time) ?? "",
      }),
    serviceUrls: Object.freeze(
      Object.fromEntries(
        Object.entries(serviceUrls ?? {}).map(([service, value]) => [
          service,
          normalizeServiceUrl(value, endpoint),
        ]),
      ),
    ),
    ...(status?.phase === undefined ? {} : { phase: status.phase as string | number }),
    ...(typeof exitCode === "number" && Number.isSafeInteger(exitCode) ? { exitCode } : {}),
    ...(typeof restartCount === "number" && Number.isSafeInteger(restartCount) && restartCount > 0
      ? { restartCount }
      : {}),
  });
}

function toStructValue(value: unknown): Record<string, unknown> {
  if (value === null) {
    return { nullValue: 0 };
  }
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new OpenShellGatewayFailure("Struct numbers must be finite.");
    }
    return { numberValue: value };
  }
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (Array.isArray(value)) {
    return { listValue: { values: value.map((entry) => toStructValue(entry)) } };
  }
  const object = asRecord(value);
  if (object === undefined) {
    throw new OpenShellGatewayFailure("Struct values must be JSON-compatible.");
  }
  return {
    structValue: {
      fields: Object.fromEntries(
        Object.entries(object).map(([key, entry]) => [key, toStructValue(entry)]),
      ),
    },
  };
}

export function toProtobufStruct(value: RecordValue): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, toStructValue(entry)]),
  );
}

function metadataValue(token: string): string {
  const value = token.trim();
  if (value.length === 0 || /[\r\n]/.test(value)) {
    throw new OpenShellGatewayFailure("OpenShell bearer token file is empty or invalid.");
  }
  return `Bearer ${value}`;
}

// TLS forbids an IP address in SNI, and Node 25 and later reject one (DEP0123), but
// grpc-js always sends the target host as the servername. An IP endpoint therefore
// connects through this connector: no SNI, and the certificate must carry the
// endpoint IP, verified the same way the service transport does (`tlsIdentity`).
// A DNS endpoint uses createSsl. grpc-js's GRPC_SSL_CIPHER_SUITES and
// GRPC_DEFAULT_SSL_ROOTS_FILE_PATH overrides do not apply to this path.
function ipEndpointCredentials(
  grpc: typeof import("@grpc/grpc-js"),
  address: string,
  rootCertificate: Buffer | undefined,
  clientCertificate: Buffer | undefined,
  clientPrivateKey: Buffer | undefined,
): ChannelCredentials {
  const secureContext = createSecureContext({
    ...(rootCertificate === undefined ? {} : { ca: rootCertificate }),
    ...(clientCertificate === undefined ? {} : { cert: clientCertificate, key: clientPrivateKey }),
  });
  class IpEndpointCredentials extends grpc.ChannelCredentials {
    _isSecure(): boolean {
      return true;
    }
    _equals(other: ChannelCredentials): boolean {
      return other === this;
    }
    // Typed through Parameters: grpc-js does not export the GrpcUri target type.
    _createSecureConnector(
      ...[, , callCredentials]: Parameters<ChannelCredentials["_createSecureConnector"]>
    ): ReturnType<ChannelCredentials["_createSecureConnector"]> {
      return {
        connect: (socket) =>
          new Promise((resolve, reject) => {
            const tlsSocket = tlsConnect(
              {
                socket,
                secureContext,
                ALPNProtocols: ["h2"],
                checkServerIdentity: (_name, certificate) =>
                  checkServerIdentity(address, certificate),
              },
              () => {
                if (!tlsSocket.authorized) {
                  reject(tlsSocket.authorizationError);
                  return;
                }
                resolve({ socket: tlsSocket, secure: true });
              },
            );
            tlsSocket.on("error", reject);
          }),
        waitForReady: () => Promise.resolve(),
        getCallCredentials: () => callCredentials ?? grpc.CallCredentials.createEmpty(),
        destroy: () => {},
      };
    }
  }
  return new IpEndpointCredentials();
}

export async function openShellGatewayGrpcMetadata(
  grpc: typeof import("@grpc/grpc-js"),
  auth: OpenShellGatewayClientOptions["auth"],
): Promise<Metadata> {
  const value = new grpc.Metadata();
  if (auth?.mode !== "bearerTokenFile") {
    return value;
  }
  if (!isAbsolute(auth.path)) {
    throw new OpenShellGatewayFailure("OpenShell bearer token file path must be absolute.");
  }
  value.set("authorization", metadataValue(await readFile(auth.path, "utf8")));
  return value;
}

async function loadGrpc(): Promise<{
  readonly grpc: typeof import("@grpc/grpc-js");
  readonly loader: typeof import("@grpc/proto-loader");
}> {
  try {
    const [grpc, loader] = await Promise.all([import(CLIENT_MODULE), import(LOADER_MODULE)]);
    return { grpc, loader };
  } catch (error) {
    throw new OpenShellGatewayFailure(
      `The OpenShell Sandbox Driver requires ${CLIENT_MODULE} and ${LOADER_MODULE}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export class GrpcOpenShellGatewayClient implements OpenShellGatewayClient {
  private readonly options: OpenShellGatewayClientOptions;
  private readonly requestTimeoutMs: number;
  private readonly sandboxDeleteTimeoutMs: number;
  private client:
    | Promise<{
        readonly grpc: typeof import("@grpc/grpc-js");
        readonly client: OpenShellGrpcClient;
      }>
    | undefined;

  constructor(options: OpenShellGatewayClientOptions) {
    this.options = options;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1000) {
      throw new OpenShellGatewayFailure("OpenShell request timeout must be at least 1000 ms.");
    }
    this.sandboxDeleteTimeoutMs = Math.max(
      this.requestTimeoutMs,
      options.sandboxDeleteTimeoutMs ?? DEFAULT_SANDBOX_DELETE_TIMEOUT_MS,
    );
    if (!Number.isSafeInteger(this.sandboxDeleteTimeoutMs)) {
      throw new OpenShellGatewayFailure("OpenShell Sandbox delete timeout must be an integer.");
    }
    if (options.auth?.mode === "bearerTokenFile" && !isAbsolute(options.auth.path)) {
      throw new OpenShellGatewayFailure("OpenShell bearer token file path must be absolute.");
    }
    if (options.auth?.mode === "mutualTls" || options.auth?.mode === "mtls") {
      if (!normalizeEndpoint(options.endpoint).secure) {
        throw new OpenShellGatewayFailure("OpenShell mTLS requires an HTTPS endpoint.");
      }
      if (!isAbsolute(options.auth.certificatePath) || !isAbsolute(options.auth.privateKeyPath)) {
        throw new OpenShellGatewayFailure(
          "OpenShell mTLS certificate and private key paths must be absolute.",
        );
      }
    }
    if (options.rootCertificatePath !== undefined && !isAbsolute(options.rootCertificatePath)) {
      throw new OpenShellGatewayFailure("OpenShell root certificate path must be absolute.");
    }
  }

  async getServiceDocument(
    serviceUrl: string,
    path: string,
    bearer: string,
    signal: AbortSignal,
  ): Promise<OpenShellServiceDocument> {
    return getServiceDocument(this.serviceTransportOptions(), serviceUrl, path, bearer, signal);
  }

  async postServiceDocument(
    serviceUrl: string,
    path: string,
    bearer: string,
    body: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<OpenShellServiceDocument> {
    return postServiceDocument(
      this.serviceTransportOptions(),
      serviceUrl,
      path,
      bearer,
      body,
      signal,
    );
  }

  async serviceWebSocketHandshake(
    serviceUrl: string,
    bearer: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    return serviceWebSocketHandshake(this.serviceTransportOptions(), serviceUrl, bearer, signal);
  }

  private serviceRootCertificate: Buffer | undefined;

  private serviceTransportOptions() {
    // Validates the endpoint exactly as the gRPC channel does, and like it reads the
    // root certificate once.
    normalizeEndpoint(this.options.endpoint);
    if (this.options.rootCertificatePath !== undefined) {
      this.serviceRootCertificate ??= readFileSync(this.options.rootCertificatePath);
    }
    return {
      endpoint: this.options.endpoint,
      requestTimeoutMs: this.requestTimeoutMs,
      ...(this.serviceRootCertificate === undefined
        ? {}
        : { rootCertificate: this.serviceRootCertificate }),
    };
  }

  async getPolicyStatus(
    request: OpenShellPolicyRequest,
    signal: AbortSignal,
  ): Promise<OpenShellPolicyStatus> {
    const response = await this.unary(
      "GetSandboxPolicyStatus",
      { sandbox: request.sandbox, workspace_scope: { workspace: request.workspace } },
      signal,
    );
    const revision = asRecord(response.revision);
    const policy = asRecord(revision?.policy);
    if (
      policy === undefined ||
      !Number.isSafeInteger(revision?.version) ||
      typeof revision?.status !== "string"
    ) {
      throw new OpenShellGatewayFailure("Invalid Sandbox policy status.");
    }
    return {
      version: revision!.version as number,
      activeVersion: Number(response.active_version ?? 0),
      state: revision!.status as string,
      policy,
    };
  }

  async updatePolicy(
    request: OpenShellPolicyRequest & {
      readonly policy: Readonly<Record<string, unknown>>;
      readonly expectedResourceVersion: string;
      readonly requestId: string;
    },
    signal: AbortSignal,
  ): Promise<void> {
    if (!/^[1-9][0-9]*$/.test(request.expectedResourceVersion)) {
      throw new OpenShellGatewayFailure("A nonzero expected resource version is required.");
    }
    await this.unary(
      "UpdateConfig",
      {
        sandbox: request.sandbox,
        workspace_scope: { workspace: request.workspace },
        policy: request.policy,
        expected_resource_version: request.expectedResourceVersion,
        request_id: request.requestId,
      },
      signal,
    );
  }

  async getPolicyDrafts(
    request: OpenShellPolicyRequest,
    signal: AbortSignal,
  ): Promise<{
    readonly chunks: readonly Readonly<Record<string, unknown>>[];
    readonly version: string;
  }> {
    const response = await this.unary(
      "GetDraftPolicy",
      { sandbox: request.sandbox, workspace_scope: { workspace: request.workspace } },
      signal,
    );
    if (response.chunks === undefined) {
      return { chunks: [], version: String(response.draft_version ?? "0") };
    }
    if (!Array.isArray(response.chunks)) {
      throw new OpenShellGatewayFailure("Invalid policy recommendations.");
    }
    return { chunks: response.chunks, version: String(response.draft_version ?? "0") };
  }

  async health(signal: AbortSignal): Promise<void> {
    const response = await this.unary("Health", {}, signal);
    const status = response.status;
    if (status !== "SERVICE_STATUS_HEALTHY" && status !== 1) {
      throw new OpenShellGatewayFailure("OpenShell gateway is not healthy.");
    }
  }

  async execSandbox(request: OpenShellSandboxExecRequest, signal: AbortSignal): Promise<number> {
    const stdin = Buffer.from(request.stdin, "utf8");
    if (
      stdin.length > 400_000 ||
      request.command.length === 0 ||
      request.command.length > 1024 ||
      request.command.some(
        (argument) => argument.includes("\0") || Buffer.byteLength(argument) > 32_768,
      ) ||
      Buffer.byteLength(JSON.stringify([request.command, request.environment])) > 1_000_000 ||
      !Number.isSafeInteger(request.timeoutSeconds) ||
      request.timeoutSeconds < 1 ||
      request.timeoutSeconds > 300
    ) {
      throw new OpenShellGatewayFailure(
        "OpenShell workspace initialization exceeds execution limits.",
      );
    }
    const message = {
      workspace_scope: { workspace: nonempty(request.workspace, "OpenShell Workspace name") },
      sandbox: nonempty(request.sandbox, "OpenShell Sandbox name"),
      command: [...request.command],
      environment: { ...request.environment },
      stdin,
      execution_timeout: { seconds: request.timeoutSeconds, nanos: 0 },
      tty: false,
      no_login_shell: true,
    };
    signal.throwIfAborted();
    const { grpc, client } = await this.ensureClient();
    signal.throwIfAborted();
    const headers = await openShellGatewayGrpcMetadata(grpc, this.options.auth);
    signal.throwIfAborted();
    return new Promise<number>((resolve, reject) => {
      let call: ClientReadableStream<RecordValue> | undefined;
      let exitCode: number | undefined;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", abort);
        if (error !== undefined) {
          reject(error);
        } else if (exitCode === undefined) {
          reject(new OpenShellGatewayFailure("OpenShell execution ended without an exit status."));
        } else {
          resolve(exitCode);
        }
      };
      const abort = () => {
        finish(gatewayRequestFailure("ExecSandbox", { code: grpc.status.CANCELLED }));
        call?.cancel();
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      try {
        call = client.ExecSandbox(message, headers, {
          deadline: deadline((request.timeoutSeconds + 5) * 1000),
        });
        call.on("data", (event: unknown) => {
          if (settled) {
            return;
          }
          const exit = asRecord(asRecord(event)?.exit);
          if (exit === undefined) {
            // stdout/stderr can contain private documents; never retain or report them.
            return;
          }
          const value = exit.exit_code ?? 0;
          if (exitCode !== undefined || typeof value !== "number" || !Number.isInteger(value)) {
            finish(
              new OpenShellGatewayFailure("OpenShell execution returned an invalid exit status."),
            );
            call?.cancel();
            return;
          }
          exitCode = value;
        });
        call.on("error", (error: unknown) => {
          finish(
            gatewayRequestFailure(
              "ExecSandbox",
              { code: rawStatusCode(error) },
              gatewayDidNotAnswer(error),
            ),
          );
        });
        call.on("end", () => finish());
      } catch (error) {
        finish(
          gatewayRequestFailure(
            "ExecSandbox",
            { code: rawStatusCode(error) },
            gatewayDidNotAnswer(error),
          ),
        );
        call?.cancel();
      }
    });
  }

  async getGatewayInfo(signal: AbortSignal): Promise<RecordValue> {
    return this.unary("GetGatewayInfo", {}, signal);
  }

  /** A snapshot, never a lock against a later operator attachment. */
  async readExclusivePreviewWorkspace(workspace: string, sandboxId: string, signal: AbortSignal) {
    const workspace_scope = { workspace: nonempty(workspace, "preview workspace") };
    const members = await this.unary(
      "ListWorkspaceMembers",
      { workspace_scope, page_size: 1 },
      signal,
    );
    if (
      members.next_page_token ||
      !Array.isArray(members.members ?? []) ||
      (members.members as unknown[] | undefined)?.length
    ) {
      return false;
    }
    const { sandboxes, next_page_token } = await this.unary(
      "ListSandboxes",
      { workspace_scope, page_size: 2 },
      signal,
    );
    const only = Array.isArray(sandboxes) && sandboxes.length === 1 && asRecord(sandboxes[0]);
    const meta = only && asRecord(only.metadata);
    return (
      !!sandboxId &&
      !!meta &&
      !next_page_token &&
      meta.id === sandboxId &&
      meta.workspace === workspace
    );
  }

  async getSandboxConfig(workspace: string, sandbox: string, signal: AbortSignal) {
    return this.unary(
      "GetSandboxConfig",
      { name: sandbox, workspace_scope: { workspace } },
      signal,
    );
  }

  async getSandboxPolicyStatus(
    workspace: string,
    sandbox: string,
    signal: AbortSignal,
  ): Promise<RecordValue> {
    return this.unary(
      "GetSandboxPolicyStatus",
      { sandbox, workspace_scope: { workspace }, version: 0 },
      signal,
    );
  }

  async getWorkspace(
    name: string,
    signal: AbortSignal,
  ): Promise<OpenShellWorkspaceResponse | undefined> {
    try {
      return workspaceResponse(
        await this.unary(
          "GetWorkspace",
          { name: nonempty(name, "OpenShell Workspace name") },
          signal,
        ),
        "GetWorkspace",
      );
    } catch (error) {
      const { grpc } = await this.ensureClient();
      if (statusCode(error) === grpc.status.NOT_FOUND) {
        return undefined;
      }
      throw error;
    }
  }

  async createWorkspace(
    name: string,
    labels: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<OpenShellWorkspaceResponse> {
    const workspaceName = nonempty(name, "OpenShell Workspace name");
    try {
      return workspaceResponse(
        await this.unary(
          "CreateWorkspace",
          { name: workspaceName, labels: { ...labels }, request_id: randomUUID() },
          signal,
        ),
        "CreateWorkspace",
      );
    } catch (error) {
      const { grpc } = await this.ensureClient();
      if (statusCode(error) === grpc.status.ALREADY_EXISTS) {
        throw new OpenShellWorkspaceAlreadyExistsError(workspaceName);
      }
      throw error;
    }
  }

  async deleteWorkspace(name: string, signal: AbortSignal): Promise<void> {
    let response: RecordValue;
    try {
      response = await this.unary(
        "DeleteWorkspace",
        {
          name: nonempty(name, "OpenShell Workspace name"),
          allow_missing: true,
          request_id: randomUUID(),
        },
        signal,
      );
    } catch (error) {
      const { grpc } = await this.ensureClient();
      if (statusCode(error) === grpc.status.NOT_FOUND) {
        return;
      }
      throw error;
    }
    if (
      !["DELETION_OUTCOME_COMPLETED", "DELETION_OUTCOME_ALREADY_ABSENT", 1, 3].includes(
        response.outcome as string | number,
      )
    ) {
      throw new OpenShellGatewayFailure(
        "OpenShell DeleteWorkspace did not confirm Workspace deletion.",
      );
    }
  }

  async createSandbox(
    request: OpenShellSandboxCreateRequest,
    signal: AbortSignal,
  ): Promise<OpenShellSandboxResponse> {
    let response: RecordValue;
    try {
      response = await this.unary(
        "CreateSandbox",
        {
          name: request.name,
          workspace_scope: { workspace: request.workspace },
          request_id: request.requestId,
          labels: { ...request.labels },
          annotations: { ...request.annotations },
          spec: request.spec,
          service_exposures: request.serviceExposures.map(
            ({ service, targetPort, authorizationMode }) => ({
              service,
              target_port: targetPort,
              authorization_mode:
                authorizationMode === "bearer_passthrough"
                  ? "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH"
                  : "SERVICE_AUTHORIZATION_MODE_STRIP",
            }),
          ),
        },
        signal,
      );
    } catch (error) {
      const { grpc } = await this.ensureClient();
      if (statusCode(error) === grpc.status.ALREADY_EXISTS) {
        throw new OpenShellSandboxAlreadyExistsError(request.name);
      }
      const reason = openShellErrorReason(error, grpc.status.FAILED_PRECONDITION);
      if (
        statusCode(error) === grpc.status.FAILED_PRECONDITION &&
        reason !== undefined &&
        REPLAY_REFUSAL_REASONS.has(reason)
      ) {
        const details = asRecord(error)?.details;
        throw new OpenShellRequestReplayRefusedError(
          reason,
          typeof details === "string" ? details : "request_id refused",
        );
      }
      throw error;
    }
    const serviceUrls = asRecord(response.service_urls);
    if (serviceUrls === undefined && request.serviceExposures.length !== 0) {
      throw new OpenShellGatewayFailure("OpenShell CreateSandbox returned no service URL map.");
    }
    return sandboxResponse(
      response,
      "CreateSandbox",
      this.options.endpoint,
      request.serviceExposures.length !== 0,
    );
  }

  async getSandbox(
    request: OpenShellSandboxDeleteRequest,
    signal: AbortSignal,
  ): Promise<OpenShellSandboxResponse | undefined> {
    try {
      return sandboxResponse(
        await this.unary(
          "GetSandbox",
          { name: request.name, workspace_scope: { workspace: request.workspace } },
          signal,
        ),
        "GetSandbox",
        this.options.endpoint,
        false,
      );
    } catch (error) {
      if (await this.isStatus(error, "NOT_FOUND")) {
        return undefined;
      }
      throw error;
    }
  }

  async getServiceUrl(
    request: OpenShellServiceRequest,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    let response: RecordValue;
    try {
      response = await this.unary(
        "GetService",
        {
          sandbox: request.sandbox,
          name: request.service,
          workspace_scope: { workspace: request.workspace },
        },
        signal,
      );
    } catch (error) {
      if (await this.isStatus(error, "NOT_FOUND")) {
        return undefined;
      }
      throw error;
    }
    return normalizeServiceUrl(response.url, this.options.endpoint);
  }

  async getService(
    workspace: string,
    sandbox: string,
    name: string,
    signal: AbortSignal,
  ): Promise<OpenShellServiceResponse | undefined> {
    let response: RecordValue;
    try {
      response = await this.unary(
        "GetService",
        {
          sandbox: nonempty(sandbox, "OpenShell Sandbox name"),
          name,
          workspace_scope: { workspace },
        },
        signal,
      );
    } catch (error) {
      signal.throwIfAborted();
      const { grpc } = await this.ensureClient();
      if (statusCode(error) === grpc.status.NOT_FOUND) {
        return undefined;
      }
      throw error;
    }
    const endpoint = asRecord(response.endpoint);
    const endpointName = endpoint?.name ?? "";
    const targetPort = endpoint?.target_port;
    const authorizationMode = endpoint?.authorization_mode;
    if (
      endpoint?.sandbox !== sandbox ||
      endpointName !== name ||
      typeof targetPort !== "number" ||
      !Number.isSafeInteger(targetPort) ||
      targetPort < 1 ||
      targetPort > 65_535 ||
      (typeof authorizationMode !== "string" && typeof authorizationMode !== "number")
    ) {
      throw new OpenShellGatewayFailure("OpenShell GetService returned an invalid endpoint.");
    }
    return Object.freeze({
      sandbox,
      name,
      targetPort,
      authorizationMode,
      advertisedUrl: serviceUrl(response.url).toString(),
      url: normalizeServiceUrl(response.url, this.options.endpoint),
    });
  }

  async deleteService(
    workspace: string,
    sandbox: string,
    name: string,
    signal: AbortSignal,
  ): Promise<void> {
    let response: RecordValue;
    try {
      // No request_id: the delete is idempotent by itself, and a durable admission per call
      // would count against the gateway identity's limit on every reconcile pass.
      response = await this.unary(
        "DeleteService",
        {
          sandbox: nonempty(sandbox, "OpenShell Sandbox name"),
          name,
          workspace_scope: { workspace },
          allow_missing: true,
        },
        signal,
      );
    } catch (error) {
      if (await this.isStatus(error, "NOT_FOUND")) {
        // A Sandbox that is gone and one this identity is not allowed to see answer alike
        // (finding 1670): neither confirms the endpoint gone, so the caller decides with a
        // read it can trust.
        throw new OpenShellDeletionUnconfirmedError(
          "OpenShell DeleteService did not find the Sandbox, so the deletion is unconfirmed.",
          { cause: error },
        );
      }
      throw error;
    }
    if (!deletionConfirmed(response)) {
      throw new OpenShellGatewayFailure("OpenShell DeleteService did not confirm deletion.");
    }
  }

  /**
   * Resolves only once OpenShell reports the Sandbox gone: COMPLETED or ALREADY_ABSENT from
   * DeleteSandbox, or, after ACCEPTED (or no outcome), GetSandbox no longer finding the
   * targeted Sandbox. NOT_FOUND from DeleteSandbox is a failure: OpenShell answers it alike
   * for a Sandbox that is gone and for one this identity may not see (finding 1676), so it
   * confirms nothing, and the caller decides with a read it can trust (`confirmSandboxAbsent`).
   * After ACCEPTED, NOT_FOUND from GetSandbox does confirm: ACCEPTED proves this identity was
   * allowed to delete the Sandbox, and OpenShell finishes an accepted deletion by itself or
   * keeps the record in DELETING, which a member identity still reads.
   * One deadline bounds the call and that wait (a GetSandbox in flight can overrun it by one
   * request timeout); past it the deletion is reported as an unavailable dependency, so the
   * caller retries the idempotent delete instead of treating the Sandbox as removed.
   */
  async deleteSandbox(request: OpenShellSandboxDeleteRequest, signal: AbortSignal): Promise<void> {
    const deadlineAt = Date.now() + this.sandboxDeleteTimeoutMs;
    let response: RecordValue;
    try {
      response = await this.unary(
        "DeleteSandbox",
        { name: request.name, workspace_scope: { workspace: request.workspace } },
        signal,
        this.sandboxDeleteTimeoutMs,
      );
    } catch (error) {
      const { grpc } = await this.ensureClient();
      if (statusCode(error) === grpc.status.NOT_FOUND) {
        throw new OpenShellDeletionUnconfirmedError(
          "OpenShell DeleteSandbox did not find the Sandbox, so the deletion is unconfirmed.",
          { cause: error },
        );
      }
      throw error;
    }
    if (deletionConfirmed(response)) {
      return;
    }
    // ACCEPTED: the gateway record still exists while OpenShell finishes cleanup. Watch the
    // targeted Sandbox ID when OpenShell names it, so a same-name replacement does not hold
    // this wait open.
    const sandboxId = isNonEmptyString(response.sandbox_id) ? response.sandbox_id : undefined;
    for (;;) {
      const current = await this.getSandbox(request, signal);
      if (
        current === undefined ||
        (sandboxId !== undefined && current.id !== undefined && current.id !== sandboxId)
      ) {
        return;
      }
      if (Date.now() + SANDBOX_DELETE_POLL_INTERVAL_MS >= deadlineAt) {
        throw new DependencyUnavailableError(
          `OpenShell accepted deletion of Sandbox ${request.name} but did not finish it within ${Math.round(
            this.sandboxDeleteTimeoutMs / 1000,
          )} s.`,
        );
      }
      try {
        await sleep(SANDBOX_DELETE_POLL_INTERVAL_MS, undefined, { signal });
      } catch (error) {
        throw signal.aborted ? (signal.reason ?? error) : error;
      }
    }
  }

  async getSandboxLogs(
    request: OpenShellSandboxLogsRequest,
    signal: AbortSignal,
  ): Promise<OpenShellSandboxLogsResponse> {
    if (
      !Number.isSafeInteger(request.lines) ||
      request.lines < 1 ||
      request.lines > MAX_SANDBOX_LOG_LINES
    ) {
      throw new OpenShellGatewayFailure("OpenShell log line count must be 1 to 2000.");
    }
    const response = await this.unary(
      "GetSandboxLogs",
      {
        sandbox: nonempty(request.sandbox, "OpenShell Sandbox name"),
        workspace_scope: { workspace: nonempty(request.workspace, "OpenShell Workspace name") },
        lines: request.lines,
        ...(request.sinceTime === undefined
          ? {}
          : { since_time: timestampMessage(request.sinceTime) }),
      },
      signal,
    );
    const logs = Array.isArray(response.logs) ? response.logs : [];
    if (logs.length > request.lines) {
      throw new OpenShellGatewayFailure("OpenShell GetSandboxLogs returned too many lines.");
    }
    const bufferTotal = Number(response.buffer_total ?? 0);
    return Object.freeze({
      lines: Object.freeze(logs.map(sandboxLogLine)),
      bufferTotal: Number.isSafeInteger(bufferTotal) && bufferTotal >= 0 ? bufferTotal : 0,
    });
  }

  async getProviderProfile(
    workspace: string | null,
    id: string,
    signal: AbortSignal,
  ): Promise<OpenShellStoredProviderProfile | undefined> {
    let response: RecordValue;
    try {
      response = await this.unary(
        "GetProviderProfile",
        {
          id: nonempty(id, "OpenShell provider profile ID"),
          // Stock selects the platform profile only when workspace_scope is absent.
          ...(workspace !== null && {
            workspace_scope: { workspace: nonempty(workspace, "OpenShell Workspace name") },
          }),
        },
        signal,
      );
    } catch (error) {
      if (await this.isStatus(error, "NOT_FOUND")) {
        return undefined;
      }
      throw error;
    }
    const profile = asRecord(response.profile);
    if (typeof profile?.id !== "string" || profile.id !== id) {
      throw new OpenShellGatewayFailure("OpenShell GetProviderProfile returned another profile.");
    }
    return storedProviderProfile(profile, profile.id);
  }

  async listProviderProfiles(
    workspace: string,
    signal: AbortSignal,
  ): Promise<readonly OpenShellStoredProviderProfile[]> {
    const profiles: OpenShellStoredProviderProfile[] = [];
    let pageToken = "";
    do {
      const response = await this.unary(
        "ListProviderProfiles",
        { page_size: 100, page_token: pageToken, workspace_scope: { workspace } },
        signal,
      );
      for (const value of Array.isArray(response.profiles) ? response.profiles : []) {
        const profile = asRecord(value);
        if (typeof profile?.id !== "string" || profile.id.length === 0) {
          throw new OpenShellGatewayFailure(
            "OpenShell ListProviderProfiles returned a profile without an ID.",
          );
        }
        profiles.push(storedProviderProfile(profile, profile.id));
      }
      pageToken = typeof response.next_page_token === "string" ? response.next_page_token : "";
    } while (pageToken.length > 0);
    return Object.freeze(profiles);
  }

  async importProviderProfile(
    workspace: string,
    profile: OpenShellProviderProfile,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.unary(
      "ImportProviderProfiles",
      {
        profiles: [{ profile: profileMessage(profile), source: "openclaw-enterprise" }],
        workspace_scope: { workspace },
        request_id: randomUUID(),
      },
      signal,
    );
    profileDiagnosticsFailure(response, "ImportProviderProfiles");
    if (response.imported !== true) {
      throw new OpenShellGatewayFailure("OpenShell ImportProviderProfiles did not import.");
    }
  }

  async updateProviderProfile(
    workspace: string,
    profile: OpenShellProviderProfile,
    expectedResourceVersion: string,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.unary(
      "UpdateProviderProfiles",
      {
        id: profile.id,
        profile: { profile: profileMessage(profile), source: "openclaw-enterprise" },
        expected_resource_version: expectedResourceVersion,
        workspace_scope: { workspace },
        request_id: randomUUID(),
      },
      signal,
    );
    profileDiagnosticsFailure(response, "UpdateProviderProfiles");
    if (response.updated !== true) {
      throw new OpenShellGatewayFailure("OpenShell UpdateProviderProfiles did not update.");
    }
  }

  async deleteProviderProfile(workspace: string, id: string, signal: AbortSignal): Promise<void> {
    const response = await this.unary(
      "DeleteProviderProfile",
      {
        id: nonempty(id, "OpenShell provider profile ID"),
        workspace_scope: { workspace },
        allow_missing: true,
        request_id: randomUUID(),
      },
      signal,
    );
    if (!deletionConfirmed(response)) {
      throw new OpenShellGatewayFailure(
        "OpenShell DeleteProviderProfile did not confirm deletion.",
      );
    }
  }

  async createProvider(
    request: OpenShellProviderCreateRequest,
    signal: AbortSignal,
  ): Promise<OpenShellProviderResponse> {
    const name = nonempty(request.name, "OpenShell provider name");
    let response: RecordValue;
    try {
      response = await this.unary(
        "CreateProvider",
        {
          provider: {
            metadata: { name, labels: { ...request.labels } },
            type: nonempty(request.type, "OpenShell provider type"),
            // OCC imports its profiles into the same workspace as the provider.
            profile_workspace: request.workspace,
            credentials: { ...request.credentials },
            credential_expiration_times: Object.fromEntries(
              Object.entries(request.credentialExpirationTimes ?? {}).map(([key, value]) => [
                key,
                timestampMessage(value),
              ]),
            ),
            config: { ...(request.config ?? {}) },
          },
          workspace_scope: { workspace: request.workspace },
          request_id: randomUUID(),
        },
        signal,
      );
    } catch (error) {
      if (await this.isStatus(error, "ALREADY_EXISTS")) {
        throw new OpenShellProviderAlreadyExistsError(name);
      }
      throw error;
    }
    return providerResponse(response.provider, "CreateProvider");
  }

  async getProvider(
    workspace: string,
    name: string,
    signal: AbortSignal,
  ): Promise<OpenShellProviderResponse | undefined> {
    let response: RecordValue;
    try {
      response = await this.unary(
        "GetProvider",
        { name: nonempty(name, "OpenShell provider name"), workspace_scope: { workspace } },
        signal,
      );
    } catch (error) {
      if (await this.isStatus(error, "NOT_FOUND")) {
        return undefined;
      }
      throw error;
    }
    return providerResponse(response.provider, "GetProvider");
  }

  async listProviders(
    workspace: string,
    signal: AbortSignal,
  ): Promise<readonly OpenShellProviderResponse[]> {
    const providers: OpenShellProviderResponse[] = [];
    let pageToken = "";
    do {
      const response = await this.unary(
        "ListProviders",
        { page_size: 100, page_token: pageToken, workspace_scope: { workspace } },
        signal,
      );
      for (const provider of Array.isArray(response.providers) ? response.providers : []) {
        providers.push(providerResponse(provider, "ListProviders"));
      }
      pageToken = typeof response.next_page_token === "string" ? response.next_page_token : "";
    } while (pageToken.length > 0);
    return Object.freeze(providers);
  }

  async deleteProvider(workspace: string, name: string, signal: AbortSignal): Promise<void> {
    const response = await this.unary(
      "DeleteProvider",
      {
        name: nonempty(name, "OpenShell provider name"),
        workspace_scope: { workspace },
        allow_missing: true,
        request_id: randomUUID(),
      },
      signal,
    );
    if (!deletionConfirmed(response)) {
      throw new OpenShellGatewayFailure("OpenShell DeleteProvider did not confirm deletion.");
    }
  }

  async updateProviderCredentials(
    workspace: string,
    name: string,
    credentials: Readonly<Record<string, string>>,
    signal: AbortSignal,
    credentialExpirationTimes: Readonly<Record<string, string>> = {},
  ): Promise<void> {
    if (Object.values(credentials).some((value) => !isNonEmptyString(value))) {
      // An empty value would leave the existing credential in place instead of replacing it.
      throw new OpenShellGatewayFailure("OpenShell provider credential updates must be nonempty.");
    }
    await this.unary(
      "UpdateProvider",
      {
        provider: {
          metadata: { name: nonempty(name, "OpenShell provider name") },
          credentials: { ...credentials },
        },
        workspace_scope: { workspace },
        credential_expiration_times: Object.fromEntries(
          Object.entries(credentialExpirationTimes).map(([key, value]) => [
            key,
            timestampMessage(value),
          ]),
        ),
        request_id: randomUUID(),
      },
      signal,
    );
  }

  async updateProviderCredentialsConditionally(
    request: OpenShellProviderCreateRequest,
    expectedResourceVersion: string,
    signal: AbortSignal,
  ): Promise<OpenShellProviderResponse> {
    if (
      !/^[1-9]\d*$/u.test(expectedResourceVersion) ||
      Object.keys(request.credentials).length === 0 ||
      Object.values(request.credentials).some((value) => !isNonEmptyString(value))
    ) {
      throw new OpenShellGatewayFailure(
        "OpenShell credential rotation requires values and a positive resource version.",
      );
    }
    const response = await this.unary(
      "UpdateProvider",
      {
        provider: {
          metadata: {
            name: nonempty(request.name, "OpenShell provider name"),
            resource_version: expectedResourceVersion,
          },
          type: request.type,
          profile_workspace: request.workspace,
          credentials: { ...request.credentials },
        },
        workspace_scope: { workspace: request.workspace },
        credential_expiration_times: Object.fromEntries(
          Object.entries(request.credentialExpirationTimes ?? {}).map(([key, value]) => [
            key,
            timestampMessage(value),
          ]),
        ),
        request_id: randomUUID(),
      },
      signal,
    );
    return {
      ...providerResponse(response.provider, "UpdateProvider"),
      ...(Array.isArray(response.target_receipts) &&
        typeof response.mutation_id === "string" && {
          targetReceipts: response.target_receipts,
          mutationId: response.mutation_id,
        }),
    };
  }

  async updateProviderConfig(
    workspace: string,
    name: string,
    config: Readonly<Record<string, string>>,
    expectedResourceVersion: string,
    signal: AbortSignal,
  ): Promise<OpenShellProviderResponse> {
    if (
      Object.keys(config).length === 0 ||
      Object.values(config).some((value) => !isNonEmptyString(value))
    ) {
      // OpenShell interprets an empty value as a request to delete that field.
      throw new OpenShellGatewayFailure("OpenShell provider config updates must be nonempty.");
    }
    if (!/^[1-9]\d*$/u.test(expectedResourceVersion)) {
      throw new OpenShellGatewayFailure(
        "OpenShell provider config updates require a positive resource version.",
      );
    }
    const response = await this.unary(
      "UpdateProvider",
      {
        provider: {
          metadata: {
            name: nonempty(name, "OpenShell provider name"),
            resource_version: expectedResourceVersion,
          },
          config: { ...config },
        },
        workspace_scope: { workspace },
        request_id: randomUUID(),
      },
      signal,
    );
    return providerResponse(response.provider, "UpdateProvider");
  }

  async getProviderCredential(
    workspace: string,
    provider: string,
    credentialKey: string,
    signal: AbortSignal,
  ): Promise<{ readonly value: string; readonly expirationTime?: string }> {
    const response = await this.unary(
      "GetProviderCredentials",
      {
        workspace_scope: { workspace: nonempty(workspace, "OpenShell Workspace name") },
        name: nonempty(provider, "OpenShell provider name"),
        credential_keys: [nonempty(credentialKey, "OpenShell credential key")],
        // Omit minimum_remaining_lifetime to use the gateway's five-minute safety margin.
      },
      signal,
    );
    const credentials = asRecord(response.credentials);
    if (
      credentials === undefined ||
      Object.keys(credentials).length !== 1 ||
      !Object.hasOwn(credentials, credentialKey)
    ) {
      throw new OpenShellGatewayFailure("OpenShell returned an unexpected credential selection.");
    }
    const credential = asRecord(credentials[credentialKey]);
    const value = nonempty(credential?.value, "OpenShell provider credential");
    const expirationTime = timestampText(credential?.expiration_time);
    if (credential?.expiration_time !== undefined && expirationTime === null) {
      throw new OpenShellGatewayFailure("OpenShell returned an invalid credential expiration.");
    }
    if (expirationTime !== null && Date.parse(expirationTime) <= Date.now()) {
      throw new OpenShellGatewayFailure("The OpenShell credential has expired.");
    }
    return Object.freeze({ value, ...(expirationTime === null ? {} : { expirationTime }) });
  }

  async detachSandboxProvider(
    workspace: string,
    sandbox: string,
    provider: string,
    signal: AbortSignal,
    conditional?: { readonly expectedResourceVersion: string; readonly requestId: string },
  ): Promise<OpenShellProviderDetachResult | undefined> {
    if (
      conditional &&
      (!/^[1-9]\d*$/.test(conditional.expectedResourceVersion) || !conditional.requestId)
    ) {
      throw new OpenShellGatewayFailure(
        "A conditional detach requires a resource version and request ID.",
      );
    }
    let response: RecordValue;
    try {
      response = await this.unary(
        "DetachSandboxProvider",
        {
          sandbox: nonempty(sandbox, "OpenShell Sandbox name"),
          provider: nonempty(provider, "OpenShell provider name"),
          workspace_scope: { workspace },
          ...(conditional && { expected_resource_version: conditional.expectedResourceVersion }),
          request_id: conditional?.requestId ?? randomUUID(),
        },
        signal,
      );
    } catch (error) {
      if (await this.isStatus(error, "NOT_FOUND")) {
        return undefined;
      }
      throw error;
    }
    const receiptId = asRecord(response.receipt)?.receipt_id;
    return Object.freeze({
      ...(isNonEmptyString(receiptId) && { receiptId }),
      ...(conditional && { detached: response.detached === true }),
    });
  }

  async getSandboxProviderStatus(
    workspace: string,
    sandbox: string,
    provider: string,
    signal: AbortSignal,
    receiptId?: string,
  ): Promise<OpenShellSandboxProviderStatus> {
    const response = await this.unary(
      "GetSandboxProviderStatus",
      {
        sandbox: nonempty(sandbox, "OpenShell Sandbox name"),
        provider: nonempty(provider, "OpenShell provider name"),
        ...(receiptId === undefined ? {} : { receipt_id: receiptId }),
        workspace_scope: { workspace },
      },
      signal,
    );
    const status = asRecord(response.status);
    if (typeof status?.state !== "string") {
      throw new OpenShellGatewayFailure("OpenShell GetSandboxProviderStatus returned no state.");
    }
    const operation = asRecord(status.operation);
    const receipt = asRecord(status.receipt);
    const desired = asRecord(receipt?.desired);
    const observed = asRecord(status.observed);
    const text = (value: unknown): string => (typeof value === "string" ? value : "");
    return Object.freeze({
      state: status.state,
      ...(operation?.state === 2 &&
      operation.outcome === 1 &&
      operation.completed_time &&
      typeof operation.operation_id === "string" &&
      operation.operation_id === receipt?.receipt_id
        ? { completedOperationId: operation.operation_id }
        : {}),
      ...(operation?.state === 5 &&
      operation.outcome === 3 &&
      timestampText(operation.completed_time) !== null &&
      receipt?.kind === "PROVIDER_MUTATION_KIND_OBSERVE" &&
      typeof operation.operation_id === "string" &&
      operation.operation_id === receipt.receipt_id
        ? { supersededObservationId: operation.operation_id }
        : {}),
      ...(typeof status.reason === "string" ? { reason: status.reason } : {}),
      ...(receipt
        ? {
            receipt: Object.freeze({
              ...(typeof receipt.receipt_id === "string" && {
                receiptId: text(receipt.receipt_id),
              }),
              ...(typeof receipt.kind === "string" && { kind: text(receipt.kind) }),
              provider: text(receipt.provider),
              workspace: text(receipt.workspace),
              ...(desired
                ? {
                    desired: Object.freeze({
                      sandboxId: text(desired.sandbox_id),
                      sandbox: text(desired.sandbox),
                      attachmentEpoch: text(desired.attachment_epoch),
                      providerId: text(desired.provider_id),
                      providerResourceVersion: text(desired.provider_resource_version),
                      providerEnvRevision: text(desired.provider_env_revision),
                      configRevision: text(desired.config_revision),
                      policyHash: text(desired.policy_hash),
                    }),
                  }
                : {}),
            }),
          }
        : {}),
      ...(observed
        ? {
            observed: Object.freeze({
              sessionId: text(observed.session_id),
              sequence: text(observed.sequence),
              attachmentEpoch: text(observed.attachment_epoch),
              providerEnvRevision: text(observed.provider_env_revision),
              configRevision: text(observed.config_revision),
              policyHash: text(observed.policy_hash),
              credentialsInstalled: observed.credentials_installed === true,
              policyActive: observed.policy_active === true,
              launchEnvironmentInstalled: observed.launch_environment_installed === true,
              processInstanceId: text(observed.process_instance_id),
              reason: text(observed.reason),
            }),
          }
        : {}),
      ...(typeof status.network_instance_id === "string"
        ? { networkInstanceId: status.network_instance_id }
        : {}),
      ...(timestampText(status.observed_time)
        ? { observedTime: timestampText(status.observed_time)! }
        : {}),
      ...(timestampText(status.evaluated_time)
        ? { evaluatedTime: timestampText(status.evaluated_time)! }
        : {}),
    });
  }

  async configureProviderRefresh(
    request: OpenShellRefreshConfigureRequest,
    signal: AbortSignal,
  ): Promise<OpenShellRefreshStatus> {
    const response = await this.unary(
      "ConfigureProviderRefresh",
      {
        provider: nonempty(request.provider, "OpenShell provider name"),
        credential_key: nonempty(request.credentialKey, "OpenShell credential key"),
        strategy: request.strategy,
        ...(request.expirationTime === undefined
          ? {}
          : { expiration_time: timestampMessage(request.expirationTime) }),
        material: { ...request.material },
        workspace_scope: { workspace: request.workspace },
        request_id: nonempty(request.requestId, "OpenShell request ID"),
      },
      signal,
    );
    return refreshStatus(response.status, "ConfigureProviderRefresh");
  }

  async rotateProviderCredential(
    workspace: string,
    provider: string,
    credentialKey: string,
    requestId: string,
    signal: AbortSignal,
  ): Promise<OpenShellRefreshStatus> {
    const response = await this.unary(
      "RotateProviderCredential",
      {
        provider: nonempty(provider, "OpenShell provider name"),
        credential_key: nonempty(credentialKey, "OpenShell credential key"),
        workspace_scope: { workspace },
        request_id: nonempty(requestId, "OpenShell request ID"),
      },
      signal,
    );
    return refreshStatus(response.status, "RotateProviderCredential");
  }

  async getProviderRefreshStatus(
    workspace: string,
    provider: string,
    credentialKey: string,
    signal: AbortSignal,
  ): Promise<OpenShellRefreshStatus | undefined> {
    let response: RecordValue;
    try {
      response = await this.unary(
        "GetProviderRefreshStatus",
        {
          provider: nonempty(provider, "OpenShell provider name"),
          credential_key: nonempty(credentialKey, "OpenShell credential key"),
          workspace_scope: { workspace },
        },
        signal,
      );
    } catch (error) {
      if (await this.isStatus(error, "NOT_FOUND")) {
        return undefined;
      }
      throw error;
    }
    const credentials = Array.isArray(response.credentials) ? response.credentials : [];
    const match = credentials.find(
      (candidate) => asRecord(candidate)?.credential_key === credentialKey,
    );
    return match === undefined ? undefined : refreshStatus(match, "GetProviderRefreshStatus");
  }

  async deleteProviderRefresh(
    workspace: string,
    provider: string,
    credentialKey: string,
    signal: AbortSignal,
  ): Promise<void> {
    let response: RecordValue;
    try {
      response = await this.unary(
        "DeleteProviderRefresh",
        {
          provider: nonempty(provider, "OpenShell provider name"),
          credential_key: nonempty(credentialKey, "OpenShell credential key"),
          workspace_scope: { workspace },
          allow_missing: true,
          request_id: randomUUID(),
        },
        signal,
      );
    } catch (error) {
      // allow_missing covers absent refresh state; an absent provider is also already clean.
      if (await this.isStatus(error, "NOT_FOUND")) {
        return;
      }
      throw error;
    }
    if (!deletionConfirmed(response)) {
      throw new OpenShellGatewayFailure(
        "OpenShell DeleteProviderRefresh did not confirm deletion.",
      );
    }
  }

  close(): void {
    const current = this.client;
    this.client = undefined;
    current
      ?.then(({ client }) => client.close())
      .catch(() => {
        // Nothing useful can be done after close; future calls create a fresh client.
      });
  }

  private async unary(
    method: OpenShellMethod,
    request: RecordValue,
    signal: AbortSignal,
    timeoutMs: number = this.requestTimeoutMs,
  ): Promise<RecordValue> {
    signal.throwIfAborted();
    const { grpc, client } = await this.ensureClient();
    signal.throwIfAborted();
    const headers = await openShellGatewayGrpcMetadata(grpc, this.options.auth);
    signal.throwIfAborted();
    return new Promise<RecordValue>((resolve, reject) => {
      let call: ClientUnaryCall | undefined;
      const abort = () => {
        signal.removeEventListener("abort", abort);
        call?.cancel();
        reject(signal.reason ?? new Error("OpenShell gateway request aborted."));
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      try {
        call = client[method](
          request,
          headers,
          { deadline: deadline(timeoutMs) },
          (error, response) => {
            signal.removeEventListener("abort", abort);
            if (signal.aborted) {
              reject(signal.reason ?? new Error("OpenShell gateway request aborted."));
              return;
            }
            if (error !== null) {
              const details = asRecord(error)?.details;
              const code = statusCode(error);
              // Refresh and plaintext-read errors must not expose credential backend messages.
              if (
                [
                  "GetProviderCredentials",
                  "ConfigureProviderRefresh",
                  "RotateProviderCredential",
                  "GetProviderRefreshStatus",
                  "DeleteProviderRefresh",
                ].includes(method)
              ) {
                reject(gatewayRequestFailure(method, error));
              } else if (
                code === grpc.status.RESOURCE_EXHAUSTED &&
                typeof details === "string" &&
                details.startsWith(ADMISSION_LIMIT_DETAILS)
              ) {
                reject(new OpenShellAdmissionLimitError(method, error));
              } else if (
                [
                  grpc.status.NOT_FOUND,
                  grpc.status.ALREADY_EXISTS,
                  grpc.status.FAILED_PRECONDITION,
                  grpc.status.PERMISSION_DENIED,
                  grpc.status.UNAUTHENTICATED,
                  grpc.status.RESOURCE_EXHAUSTED,
                ].includes(code ?? -1)
              ) {
                reject(error);
              } else {
                reject(gatewayRequestFailure(method, error));
              }
              return;
            }
            resolve(asRecord(response) ?? {});
          },
        );
      } catch (error) {
        signal.removeEventListener("abort", abort);
        throw gatewayRequestFailure(method, error);
      }
    });
  }

  private async isStatus(error: unknown, name: "NOT_FOUND" | "ALREADY_EXISTS"): Promise<boolean> {
    const { grpc } = await this.ensureClient();
    const code =
      error instanceof OpenShellGatewayRequestFailure ||
      error instanceof OpenShellGatewayUnavailableError
        ? error.grpcStatus
        : statusCode(error);
    return code === grpc.status[name];
  }

  private async ensureClient(): Promise<{
    readonly grpc: typeof import("@grpc/grpc-js");
    readonly client: OpenShellGrpcClient;
  }> {
    if (this.client !== undefined) {
      return this.client;
    }
    const created = this.createClient();
    this.client = created;
    // A failed setup (unreadable root certificate, missing gRPC module) is retried
    // by the next call instead of failing every later call for this endpoint.
    created.catch(() => {
      if (this.client === created) {
        this.client = undefined;
      }
    });
    return created;
  }

  private async createClient(): Promise<{
    readonly grpc: typeof import("@grpc/grpc-js");
    readonly client: OpenShellGrpcClient;
  }> {
    const { grpc, loader } = await loadGrpc();
    const protoPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "proto",
      "openshell-gateway.proto",
    );
    const packageDefinition: PackageDefinition = await loader.load(protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: false,
      oneofs: true,
    });
    const loaded = grpc.loadPackageDefinition(packageDefinition) as unknown as {
      readonly openshell?: { readonly v1?: { readonly OpenShell?: ServiceClientConstructor } };
    };
    const OpenShell = loaded.openshell?.v1?.OpenShell;
    if (OpenShell === undefined) {
      throw new OpenShellGatewayFailure("OpenShell gRPC service was not found in the proto.");
    }
    const { target, credentials } = openShellGatewayGrpcChannel(grpc, this.options);
    return {
      grpc,
      client: new OpenShell(target, credentials, {
        "grpc.max_receive_message_length": MAX_RECEIVE_MESSAGE_BYTES,
      }) as unknown as OpenShellGrpcClient,
    };
  }
}

/** Shared control-channel identity and trust; each caller keeps its own RPC contract. */
export function openShellGatewayGrpcChannel(
  grpc: typeof import("@grpc/grpc-js"),
  options: OpenShellGatewayClientOptions,
): { readonly target: string; readonly credentials: ChannelCredentials } {
  const endpoint = normalizeEndpoint(options.endpoint);
  let credentials: ChannelCredentials = grpc.credentials.createInsecure();
  if (endpoint.secure) {
    const rootCertificate =
      options.rootCertificatePath === undefined
        ? undefined
        : readFileSync(options.rootCertificatePath);
    const address = new URL(`https://${endpoint.target}`).hostname.replace(/^\[(.*)\]$/, "$1");
    // Administrator credentials belong only to this gRPC control channel.
    // Service HTTP/WebSocket calls retain their scoped bearer identity.
    const clientCertificate =
      options.auth?.mode === "mtls" || options.auth?.mode === "mutualTls"
        ? readFileSync(options.auth.certificatePath)
        : undefined;
    const clientPrivateKey =
      options.auth?.mode === "mtls" || options.auth?.mode === "mutualTls"
        ? readFileSync(options.auth.privateKeyPath)
        : undefined;
    credentials =
      isIP(address) === 0
        ? grpc.credentials.createSsl(rootCertificate, clientPrivateKey, clientCertificate)
        : ipEndpointCredentials(
            grpc,
            address,
            rootCertificate,
            clientCertificate,
            clientPrivateKey,
          );
  }
  return { target: endpoint.target, credentials };
}

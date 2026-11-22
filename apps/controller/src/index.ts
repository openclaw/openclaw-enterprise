import { AGENT_CHAT_BODY_LIMIT, relayAgentChat } from "./http/agent-chat.ts";
import { sandboxPolicyHandlers } from "./http/sandbox-policy.ts";
import { createAgentAuditReader } from "./http/agent-audit.ts";
import swagger from "@fastify/swagger";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { AuditEventFactory, type AuditSink } from "@openclaw-enterprise/audit";
import {
  API_REQUEST_AUDIT_ACTIONS,
  AgentDeploymentDiagnosticsResponse,
  AgentRuntimeCredentialResponse,
  AgentRuntimeLogsResponse,
  AgentRuntimeResponse,
  ConnectionTemplateSchema,
  OAuthConnectionTemplateVersionSchema,
  StaticKeyConnectionTemplateVersionSchema,
  ModelProviderSchema,
  ModelProviderModelSchema,
  CredentialSourceResponse,
  RegisterTokenServiceSourceBody,
  UpdateTokenServiceSourceBody,
  PushAgentCredentialsBody,
  PushAgentCredentialsResponse,
  ErrorResponse,
  JsonValue,
  occApiRoutes,
  PluginApproversSchema,
  PluginDesiredSelectionSchema,
  PluginDesiredStateSchema,
  PluginDriverIdentitySchema,
  PluginToolDefaultsSchema,
  PluginToolPolicySchema,
  PRESET_JSON_MAX_BYTES,
  SecretResponse,
  type AgentRuntimeLogsQuery,
  type ApiRequestAuditObservation,
  type AuditEvent,
  type AuditEventKind,
  type AuthorizationEvidence,
  type BackendSummary,
  type ChannelDriver,
  type ComputeDriver,
  type ConfigurationDriver,
  type IAMDriver,
  type Installation,
  type OccApiRoute,
  type DiscoverSavedAgentPluginDetailsBody,
  type PermissionAction,
  type ResourceRef,
  type SandboxDriver,
  type SecretDriver,
  type SecretReference,
  type CredentialSourceReference,
} from "@openclaw-enterprise/contracts";
import {
  AuthAccountRoleInvalidError,
  AuthAccountRoleNotFoundError,
  NativeIAMDriver,
} from "@openclaw-enterprise/iam";
import {
  AgentPrincipalAuthorizationError,
  AuditAppendUnavailableError,
  AuthorizationDeniedError,
  DeletionRetryOwnedError,
  ComputeProvisioningRefusedError,
  createRuntimeLogCursorCodec,
  DependencyUnavailableError,
  DeviceAuthorizationScopeMismatchError,
  DeviceAuthorizationStartError,
  PostgresCommitOutcomeUnknownError,
  ResourceStateConflictError,
  RuntimeCredentialsForbiddenByClusterError,
  RuntimeLogsError,
  UserAlreadyExistsError,
  type DeployAgentAuthorization,
  type HarnessResolver,
  type OpenClawController,
  type PlatformUnitOfWork,
} from "@openclaw-enterprise/occ";
import { isNonEmptyString } from "@openclaw-enterprise/utils";
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifySchema,
  type HTTPMethods,
  type InjectOptions,
  type RouteGenericInterface,
} from "fastify";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdmittedCaller } from "./admission/admission-verifier.ts";
import {
  DEVELOPMENT_BROWSER_ORIGIN_RULE,
  isDevelopmentBrowserOrigin,
} from "./auth/configuration.ts";
import {
  OCC_SERVICE_KEY_HEADER,
  SERVICE_KEY_NAME_MAX_LENGTH,
  ServiceKeyNameRefused,
  type ClientAddressConfiguration,
  type ControllerAuth,
  type ProvisionAuthAccount,
} from "./auth/index.ts";
import { CONSOLE_CONTENT_SECURITY_POLICY, readConsoleAsset } from "./console-assets.ts";
import { createBootstrapResources } from "./composition/installation-bootstrap.ts";
import { discoverMcpAuthorization } from "./connections/mcp-discovery.ts";
import { listManagedMcpToolNames } from "./connections/mcp-tool-discovery.ts";
import type { ConsoleTheme } from "./console-theme.ts";
import type { ControllerWorkspaceFilesAccess } from "./gateway/contracts.ts";
import { normalizeNativeAdminDomain } from "./gateway/native-admin.ts";
import type { NativeAdminAccessConfig } from "./gateway/native-admin.ts";
import { createAgentHandlers } from "./http/agents.ts";
import { callerDenialMessage, GENERIC_DENIAL, requestedValues } from "./http/caller-denial.ts";
import { configurationHandlers } from "./http/configurations.ts";
import { credentialSourceHandlers } from "./http/credential-sources.ts";
import { jsonPointer } from "./http/error-details.ts";
import {
  canonicalFailure,
  cappedPath,
  dependencyUnavailable,
  dependencyUnavailableLogFields,
  failure,
  isAuthorizationDenied,
  isDependencyUnavailable,
  RequestFailure,
  requestFailure,
  responseHeaders,
  unstorableTextFailure,
} from "./http/errors.ts";
import { iamHandlers } from "./http/iam.ts";
import { MAX_JSON_BODY_DEPTH, tooDeepFailure, tooDeepJsonPath } from "./http/json-depth.ts";
import {
  createNativeAdminAccess,
  nativeAdminStatusOperation,
  nativeAdminLaunchOperation,
  nativeAdminConfirmOperation,
  nativeAdminLaunchSchema,
  nativeAdminStatusSchema,
  nativeAdminReturnOperation,
  nativeAdminReturnSchema,
  limitNativeAdminReturn,
} from "./http/native-admin.ts";
import { permissionAdvice } from "./http/permission-advice.ts";
import { createAuthRouteSchemas, installationAuthOperation } from "./http/auth-schemas.ts";
import { routePermissionMetadata, type RequiredPermission } from "./http/permission-metadata.ts";
import { presetHandlers } from "./http/presets.ts";
import { connectionTemplateHandlers } from "./http/connection-templates.ts";
import {
  CONNECTION_CALLBACK_PATH,
  connectionCallbackOperation,
  connectionCallbackSchema,
  createConnectionCallback,
  namespaceConnectionHandlers,
} from "./http/connections.ts";
import {
  isRuntimeLogDownload,
  RUNTIME_LOG_DOWNLOAD_ACTION,
  runtimeLogDownloadBody,
  runtimeLogDownloadFileName,
  RuntimeLogLimiter,
  runtimeLogPageBody,
  runtimeLogQuery,
  type AgentRuntimeLogsConfig,
} from "./http/runtime-logs.ts";
import { RequestRateLimiter } from "./http/request-rate-limiter.ts";
import {
  cachedRequestValidators,
  cachedResponseSerializers,
  defaultPrecompiledRouteCompilers,
  formatsPlugin,
} from "./http/route-compilers.ts";
import { secretHandlers } from "./http/secrets.ts";
import { serviceAccountHandlers } from "./http/service-accounts.ts";
import type { RequestContext, RequestOperation, ResourceHandlers } from "./http/types.ts";
import { createWorkspaceFileHandlers, WORKSPACE_FILE_BODY_LIMIT } from "./http/workspace-files.ts";

export { cachedRequestValidators, cachedResponseSerializers } from "./http/route-compilers.ts";

class AccountPrincipalAccessDeniedError extends AuthorizationDeniedError {
  readonly userId: string;
  readonly principalId: string;

  constructor(userId: string, principalId: string, evidence: AuthorizationEvidence) {
    super("The caller does not hold every grant of the target account's Principal.", evidence);
    this.userId = userId;
    this.principalId = principalId;
  }
}

export interface DevelopmentAdmission {
  readonly enabled: boolean;
  readonly installationId?: string;
  /** Exact browser origin for a loopback-owned development endpoint. */
  readonly browserOrigin?: string;
  readonly trustedCidrs?: readonly string[];
}

export interface ControllerAppOptions {
  readonly consoleTheme?: ConsoleTheme;
  readonly metrics?: import("./metrics/index.ts").OccMetrics;
  readonly controller?: OpenClawController;
  readonly createController?: (installation: Installation) => OpenClawController;
  readonly iamDriver: IAMDriver;
  readonly computeDriver?: ComputeDriver;
  readonly configurationDriver?: ConfigurationDriver;
  readonly channelDriver?: ChannelDriver;
  readonly secretDriver?: SecretDriver;
  readonly sandboxDriver?: SandboxDriver;
  readonly resolveHarness: HarnessResolver;
  readonly auditSink: AuditSink;
  /** Durable sink for required HTTP admission and result records. */
  readonly durableRequestAuditSink?: AuditSink;
  readonly agentAuditCursorSecret?: string;
  readonly backendSummaries?: readonly BackendSummary[];
  readonly observabilityUrl?: string;
  readonly development: DevelopmentAdmission;
  readonly maxBodyBytes?: number;
  readonly auth: ControllerAuth;
  readonly workspaceFilesAccess?: ControllerWorkspaceFilesAccess;
  readonly workspaceFileRequestTimeoutMs?: number;
  readonly discoverMcpAuthorization?: typeof discoverMcpAuthorization;
  readonly readManagedMcpToolNames?: typeof listManagedMcpToolNames;
  readonly nativeAdmin?: NativeAdminAccessConfig;
  /** Private Agent gateway transport credential, shared by native browser and HTTP chat relays. */
  readonly nativeAdminGatewayApiKey?: () => Promise<string>;
  /**
   * How often a native admin WebSocket rechecks its admission (default 25 s). The server
   * leaves it unset; tests shorten it so revocation closes do not wait the full interval.
   */
  readonly nativeAdminWebSocketLeaseIntervalMs?: number;
  /** Absent or disabled: both runtime routes answer 501. */
  readonly agentRuntimeLogs?: AgentRuntimeLogsConfig;
  readonly publicOrigin?: string;
  /** Writes the prepared account with its Principal, bindings and enrolment atomically. */
  readonly provisionAuthAccount?: ProvisionAuthAccount;
  readonly auditEventFactory?: AuditEventFactory;
  readonly logger?: FastifyBaseLogger;
  /** Production proxies allowed to send forwarded headers; admission ignores those headers. */
  readonly trustedProxies?: Pick<ClientAddressConfiguration, "trusts">;
}

export interface ControllerApp {
  fetch(request: Request): Promise<Response>;
}

interface DocumentedFastifySchema extends FastifySchema {
  readonly "x-openclaw-permissions": readonly RequiredPermission[];
}

const resourceHandlers: ResourceHandlers = {
  ...configurationHandlers,
  ...presetHandlers,
  ...secretHandlers,
  ...credentialSourceHandlers,
  ...iamHandlers,
  ...serviceAccountHandlers,
};

const DEFAULT_BODY_LIMIT = 64 * 1024;
// Four 16 KiB documents can expand sixfold in JSON, plus the ordinary create fields.
const AGENT_CREATE_BODY_LIMIT = 448 * 1024;
// A bounded template may use six-byte JSON escapes; reserve space for its name and envelope.
const PRESET_BODY_LIMIT = 6 * PRESET_JSON_MAX_BYTES + 8 * 1024;
// The bundled Kubernetes Configuration Driver stores values up to 1 MiB of JSON (its ConfigMap
// cap). A Configuration write must admit that plus the envelope (`kind` and up to 64 Secret
// bindings, each a 253-character name and a reference: under 32 KiB), all written with
// six-byte JSON escapes. Like Preset writes, these routes check the grant before the body.
const CONFIGURATION_BODY_LIMIT = 6 * (1024 * 1024 + 32 * 1024);
// Path parameters such as IAM Role and AccessBinding IDs hold up to 200 characters (code
// points). The router compares a parameter's decoded UTF-16 length, so 200 characters need
// at most 400 units; its default of 100 refused contract-valid IDs before any handler ran.
const MAX_PATH_PARAMETER_LENGTH = 400;
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const RESOURCE_ID_PREFIX = {
  namespaceId: "ns_",
  presetId: "pre_",
  configurationId: "cfg_",
  serviceAccountId: "sa_",
  secretId: "sec_",
  sessionId: "sec_",
  credentialSourceId: "cs_",
  agentId: "agt_",
  revisionId: "rev_",
  deploymentId: "rev_",
} as const;
const RESOURCE_ID = Object.fromEntries(
  Object.entries(RESOURCE_ID_PREFIX).map(([parameter, prefix]) => [
    parameter,
    new RegExp(`^${prefix}[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`),
  ]),
) as Readonly<Record<keyof typeof RESOURCE_ID_PREFIX, RegExp>>;

// Runs only after the JSON parser refused a body, to tell text that is not JSON from JSON its
// poisoning guard refused.
function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function ipv4(value: string): number | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  let result = 0;
  for (const part of parts) {
    // Same no-leading-zero rule as production trusted proxies and Compute: "010" is not 10.
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) {
      return undefined;
    }
    const octet = Number(part);
    if (octet > 255) {
      return undefined;
    }
    result = (result << 8) | octet;
  }
  return result >>> 0;
}

function cidrContains(cidr: string, address: string): boolean {
  const [network, prefixText] = cidr.split("/");
  if (network === undefined || prefixText === undefined || cidr.split("/").length !== 2) {
    throw new Error("Development trusted CIDRs must use IPv4 CIDR notation.");
  }
  const prefix = Number(prefixText);
  // "08" is not prefix 8. Production parseCidr refuses that spelling, and so does Compute.
  if (
    !/^(?:0|[1-9][0-9]{0,2})$/.test(prefixText) ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > 32
  ) {
    throw new Error("Development trusted CIDRs must use IPv4 CIDR notation.");
  }
  const networkValue = ipv4(network);
  const addressValue = ipv4(address);
  if (networkValue === undefined) {
    throw new Error("Development trusted CIDRs must use IPv4 CIDR notation.");
  }
  if (addressValue === undefined) {
    return false;
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (networkValue & mask) === (addressValue & mask);
}

function trustedDevelopmentAddress(
  development: DevelopmentAdmission,
  remoteAddress: string,
): boolean {
  if (LOOPBACK_ADDRESSES.has(remoteAddress)) {
    return true;
  }
  const cidrs = development.trustedCidrs ?? [];
  if (cidrs.length === 0) {
    return false;
  }
  const normalized = remoteAddress.startsWith("::ffff:")
    ? remoteAddress.slice("::ffff:".length)
    : remoteAddress;
  return cidrs.some((cidr) => cidrContains(cidr, normalized));
}

function validateTrustedDevelopmentCidrs(development: DevelopmentAdmission): void {
  for (const cidr of development.trustedCidrs ?? []) {
    cidrContains(cidr, "127.0.0.1");
  }
}

function developmentBrowserOrigin(development: DevelopmentAdmission): URL | undefined {
  if (development.browserOrigin === undefined) {
    return undefined;
  }
  if (!development.enabled || !isDevelopmentBrowserOrigin(development.browserOrigin)) {
    throw new Error(`The development browser origin must be ${DEVELOPMENT_BROWSER_ORIGIN_RULE}.`);
  }
  return new URL(development.browserOrigin);
}

function validAuthorizationEvidence(value: unknown): value is AuthorizationEvidence {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<AuthorizationEvidence>;
  if (candidate.identityId !== undefined && !isNonEmptyString(candidate.identityId)) {
    return false;
  }
  return [
    candidate.groupIds,
    candidate.bindingIds,
    candidate.roleIds,
    candidate.restrictionIds,
  ].every((entries) => Array.isArray(entries) && entries.every(isNonEmptyString));
}

function validateConfiguration(value: unknown, depth = 0, path = ""): void {
  // The JSON body parser already refuses deeper bodies; this keeps the rule for any other input.
  if (depth > MAX_JSON_BODY_DEPTH) {
    throw tooDeepFailure(path);
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      validateConfiguration(entry, depth + 1, `${path}/${index}`);
    }
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw failure(400, "INVALID_REQUEST", "The supplied configuration is invalid.", [
        { path: cappedPath(`${path}/${jsonPointer(key)}`), code: "INVALID_VALUE" },
      ]);
    }
    validateConfiguration(entry, depth + 1, `${path}/${jsonPointer(key)}`);
  }
}

/** Operations whose grant check runs before their body is read (see authorizeBeforeBody). */
function authorizesBeforeBody(operation: OccApiRoute): boolean {
  return (
    operation.operationId === "createPreset" ||
    operation.operationId === "updatePreset" ||
    operation.operationId === "createConfiguration" ||
    operation.operationId === "updateConfiguration"
  );
}

function operationTarget(
  operation: RequestOperation,
  installationId: string,
  params: Readonly<Record<string, unknown>>,
): ResourceRef {
  const namespaceId = typeof params.namespaceId === "string" ? params.namespaceId : undefined;
  const configurationId =
    typeof params.configurationId === "string" ? params.configurationId : undefined;
  const serviceAccountId =
    typeof params.serviceAccountId === "string" ? params.serviceAccountId : undefined;
  const presetId = typeof params.presetId === "string" ? params.presetId : undefined;
  const secretId = typeof params.secretId === "string" ? params.secretId : undefined;
  const credentialSourceId =
    typeof params.credentialSourceId === "string" ? params.credentialSourceId : undefined;
  const agentId = typeof params.agentId === "string" ? params.agentId : undefined;
  const revisionId = typeof params.revisionId === "string" ? params.revisionId : undefined;
  if (operation.operationId === "createNamespace") {
    return { kind: "namespace", id: installationId };
  }
  if (operation.resourceKind === "preset" && namespaceId) {
    return { kind: "preset", id: presetId ?? namespaceId, namespaceId };
  }
  if (operation.operationId === "createConfiguration" && namespaceId) {
    return { kind: "configuration", id: namespaceId, namespaceId };
  }
  if (configurationId && namespaceId) {
    return { kind: "configuration", id: configurationId, namespaceId };
  }
  if (operation.operationId === "createServiceAccount" && namespaceId) {
    return { kind: "service_account", id: namespaceId, namespaceId };
  }
  if (serviceAccountId && namespaceId) {
    return { kind: "service_account", id: serviceAccountId, namespaceId };
  }
  if (
    (operation.operationId === "createSecret" || operation.operationId === "listSecrets") &&
    namespaceId
  ) {
    return { kind: "secret", id: namespaceId, namespaceId };
  }
  if (operation.operationId.endsWith("DeviceAuthorization") && namespaceId) {
    return { kind: "agent", id: agentId ?? namespaceId, namespaceId };
  }
  if (secretId && namespaceId) {
    return { kind: "secret", id: secretId, namespaceId };
  }
  if (
    (operation.operationId === "createCredentialSource" ||
      operation.operationId === "listCredentialSources" ||
      operation.operationId === "listUsableConnectionTemplates" ||
      operation.operationId === "startNamespaceConnection") &&
    namespaceId
  ) {
    return { kind: "credential_source", id: namespaceId, namespaceId };
  }
  // A route naming a credential source authorizes the resource kind it declares: withdrawal
  // routes declare the Agent.
  if (credentialSourceId && namespaceId) {
    return operation.resourceKind === "agent" && agentId
      ? { kind: "agent", id: agentId, namespaceId }
      : { kind: "credential_source", id: credentialSourceId, namespaceId };
  }
  if (
    (operation.operationId === "createAgent" ||
      operation.operationId === "validateAgentCreate" ||
      operation.operationId === "getNamespaceAgentCapabilities" ||
      operation.operationId === "provisionAgent" ||
      operation.operationId === "listRepositoryOptions") &&
    namespaceId
  ) {
    return { kind: "agent", id: namespaceId, namespaceId };
  }
  if (
    (operation.operationId === "getAgentProvisioning" ||
      operation.operationId === "retryAgentProvisioning") &&
    namespaceId &&
    typeof params.workId === "string"
  ) {
    return { kind: "agent", id: params.workId, namespaceId };
  }
  if (operation.operationId === "getAgentRevision" && namespaceId && revisionId) {
    return { kind: "agent_revision", id: revisionId, namespaceId };
  }
  if (agentId && namespaceId) {
    return { kind: "agent", id: agentId, namespaceId };
  }
  if (namespaceId) {
    return { kind: "namespace", id: namespaceId, namespaceId };
  }
  return { kind: "installation", id: installationId };
}

function clientInstallation(
  installation: Readonly<Installation>,
  computeDriver: Readonly<ComputeDriver> | undefined,
  nativeAdminEnabled: boolean,
): Record<string, unknown> {
  const agentProvisioning = computeDriver?.agentProvisioning;
  const capabilities = {
    ...installation.capabilities,
    ...(nativeAdminEnabled ? { nativeAdmin: true } : {}),
    ...(agentProvisioning === undefined
      ? {}
      : {
          agentProvisioning: { executionModes: [...agentProvisioning.executionModes] },
        }),
  };
  return {
    id: installation.id,
    name: installation.name,
    createdAt: installation.createdAt,
    ...(Object.keys(capabilities).length === 0 ? {} : { capabilities }),
  };
}

export function createFastifyApp(options: ControllerAppOptions): FastifyInstance {
  const development = Object.freeze({ ...options.development });
  const browserOrigin = developmentBrowserOrigin(development);
  if (
    options.controller &&
    development.installationId !== undefined &&
    development.installationId !== options.controller.installation.id
  ) {
    throw new Error(
      "The configured Installation does not match the controller-owned Installation.",
    );
  }
  const bodyLimit = options.maxBodyBytes ?? DEFAULT_BODY_LIMIT;
  const precompiledRouteCompilers = defaultPrecompiledRouteCompilers();
  if (!Number.isSafeInteger(bodyLimit) || bodyLimit < 1) {
    throw new Error("The controller request-body limit must be a positive integer.");
  }
  const workspaceFileRequestTimeoutMs = options.workspaceFileRequestTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(workspaceFileRequestTimeoutMs) || workspaceFileRequestTimeoutMs < 1) {
    throw new Error("The workspace file request timeout must be a positive integer.");
  }
  const nativeAdminWebSocketLeaseIntervalMs = options.nativeAdminWebSocketLeaseIntervalMs;
  if (
    nativeAdminWebSocketLeaseIntervalMs !== undefined &&
    (!Number.isSafeInteger(nativeAdminWebSocketLeaseIntervalMs) ||
      nativeAdminWebSocketLeaseIntervalMs < 1)
  ) {
    throw new Error("The native admin WebSocket lease interval must be a positive integer.");
  }
  let publicOrigin: string | undefined;
  let publicOriginHost: string | undefined;
  if (options.publicOrigin !== undefined) {
    try {
      const parsed = new URL(options.publicOrigin);
      publicOrigin = parsed.origin;
      publicOriginHost = parsed.host;
      if (
        parsed.username ||
        parsed.password ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash
      ) {
        throw new Error("Invalid public origin.");
      }
    } catch {
      throw new Error("The controller public origin must be an absolute origin URL.");
    }
  }
  validateTrustedDevelopmentCidrs(development);
  if (development.enabled && options.trustedProxies !== undefined) {
    throw new Error("Trusted proxies are a production setting.");
  }

  const app = Fastify({
    bodyLimit,
    ...(options.logger === undefined
      ? {}
      : {
          loggerInstance: options.logger,
          logController: new LogController({ disableRequestLogging: true }),
        }),
    trustProxy: false,
    requestIdHeader: false,
    genReqId: () => `req_${randomUUID()}`,
    routerOptions: { maxParamLength: MAX_PATH_PARAMETER_LENGTH },
    // Router failures happen before routing, so no hook or error handler runs; without this
    // Fastify answers its own body (echoing the path) with no request ID or security headers.
    frameworkErrors: (error, request, reply) => {
      const mapped =
        error.code === "FST_ERR_BAD_URL"
          ? failure(400, "INVALID_REQUEST", "The request path has a malformed percent-encoding.")
          : error.code === "FST_ERR_MAX_PARAM_LENGTH"
            ? failure(
                400,
                "INVALID_REQUEST",
                "The request does not match the operation contract: a path parameter is too long.",
              )
            : // FST_ERR_ASYNC_CONSTRAINT; this app registers no async route constraints.
              failure(500, "INTERNAL_ERROR", "The platform request could not be completed.");
      // No hook runs for these, so record them as the onResponse hook records other requests,
      // with no measured duration.
      options.metrics?.observeHttp("unmatched", request.method, mapped.status, 0);
      options.logger?.info({
        event: "http.completed",
        requestId: request.id,
        method: request.method,
        route: "unmatched",
        status: mapped.status,
      });
      canonicalFailure(reply, mapped);
    },
    ajv: {
      // `verbose` attaches each failure's schema and value, so contract errors can tell which
      // shape of a discriminated union a request chose (http/error-details.ts). Neither is logged or
      // returned: problems name only paths and the schema's accepted values, and http/errors.ts
      // drops both from the error once its problems are built. An onError hook runs before
      // that, so none may log `error.validation`.
      customOptions: {
        removeAdditional: false,
        coerceTypes: false,
        useDefaults: false,
        verbose: true,
      },
      plugins: [formatsPlugin],
    },
    schemaController: {
      compilersFactory: {
        buildValidator: cachedRequestValidators(precompiledRouteCompilers),
        buildSerializer: cachedResponseSerializers(precompiledRouteCompilers),
      },
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  // Shutdown (app.close) drains admitted requests, but Node and Fastify close only the
  // keep-alive sockets that are idle when it starts. A socket whose response finishes during
  // the drain would stay open until the server's 72 s keep-alive timeout, past the API Pod's
  // 30 s termination grace. Mark those responses `Connection: close`, or close the socket
  // after a response whose headers were already sent, as Node does for `Connection: close`.
  const openResponses = new Set<ServerResponse>();
  app.server.on("request", (_request: IncomingMessage, response: ServerResponse) => {
    openResponses.add(response);
    response.once("close", () => openResponses.delete(response));
  });
  app.addHook("preClose", async () => {
    for (const response of openResponses) {
      if (!response.headersSent) {
        response.setHeader("connection", "close");
      } else if (!response.writableFinished) {
        const { socket } = response;
        response.once("finish", () => socket?.destroySoon());
      }
    }
  });

  app.removeContentTypeParser("text/plain");
  // Refuse a body nested deeper than any document the API stores before it is parsed: parsing
  // allocates every level, and schema validation recurses through them (a 6 MB body of nested
  // arrays cost about 300 MB of heap, then overflowed the stack into a 500).
  const parseJson = app.getDefaultJsonParser(
    app.initialConfig.onProtoPoisoning ?? "error",
    app.initialConfig.onConstructorPoisoning ?? "error",
  );
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    const tooDeep = tooDeepJsonPath(body as string);
    if (tooDeep !== undefined) {
      done(tooDeepFailure(tooDeep), undefined);
      return;
    }
    parseJson(request, body as string, (error, parsed) => {
      // Text that is not JSON at all gets its own message (finding D762). Valid JSON the
      // poisoning guard refused, such as a __proto__ key, keeps the generic contract message.
      if (
        (error as { code?: unknown } | null)?.code === "FST_ERR_CTP_INVALID_JSON_BODY" &&
        !isJson(body as string)
      ) {
        done(failure(400, "INVALID_REQUEST", "The request body is not valid JSON."), undefined);
        return;
      }
      done(error, parsed);
    });
  });
  app.addSchema(JsonValue);
  app.addSchema(PluginDriverIdentitySchema);
  app.addSchema(PluginApproversSchema);
  app.addSchema(PluginToolPolicySchema);
  app.addSchema(PluginToolDefaultsSchema);
  app.addSchema(PluginDesiredSelectionSchema);
  app.addSchema(PluginDesiredStateSchema);
  app.addSchema(ErrorResponse);
  app.addSchema(AgentDeploymentDiagnosticsResponse);
  app.addSchema(AgentRuntimeResponse);
  app.addSchema(AgentRuntimeLogsResponse);
  app.addSchema(AgentRuntimeCredentialResponse);
  app.addSchema(SecretResponse);
  app.addSchema(CredentialSourceResponse);
  app.addSchema(OAuthConnectionTemplateVersionSchema);
  app.addSchema(ConnectionTemplateSchema);
  app.addSchema(StaticKeyConnectionTemplateVersionSchema);
  app.addSchema(ModelProviderModelSchema);
  app.addSchema(ModelProviderSchema);
  app.addSchema(RegisterTokenServiceSourceBody);
  app.addSchema(UpdateTokenServiceSourceBody);
  app.addSchema(PushAgentCredentialsBody);
  app.addSchema(PushAgentCredentialsResponse);
  void app.register(swagger, {
    convertConstToEnum: false,
    refResolver: {
      buildLocalReference(schema, _baseUri, _fragment, index) {
        // Standalone contracts have public names. Keep Swagger's names and titles for route schemas.
        if (typeof schema.$id === "string") {
          schema.title ??= schema.$id;
          switch (schema.$id) {
            case "RegisterTokenServiceSourceBody":
            case "UpdateTokenServiceSourceBody":
            case "PushAgentCredentialsBody":
            case "PushAgentCredentialsResponse":
              return schema.$id;
          }
        }
        return `def-${index}`;
      },
    },
    openapi: {
      openapi: "3.1.0",
      info: {
        title: development.enabled ? "Development OCC API" : "Internal OCC API",
        version: "0.1.0",
      },
      components: {
        securitySchemes: {
          sessionCookie: {
            type: "apiKey",
            in: "cookie",
            name: options.auth?.sessionCookieName ?? "openclaw_occ.session_token",
          },
          serviceApiKey: { type: "apiKey", in: "header", name: OCC_SERVICE_KEY_HEADER },
        },
      },
      security: [{ sessionCookie: [] }, { serviceApiKey: [] }],
    },
  });

  let controller = options.controller;
  let bootstrapping = false;
  const installationId =
    development.installationId ?? controller?.installation.id ?? `ins_${randomUUID()}`;
  const admissions = new WeakMap<FastifyRequest, AdmittedCaller>();
  const contexts = new WeakMap<FastifyRequest, RequestContext>();
  const requestStartedAt = new WeakMap<FastifyRequest, bigint>();
  const requestAuditState = new WeakMap<
    FastifyRequest,
    {
      denialObserved: boolean;
      resultSelected: boolean;
      readTarget?: ResourceRef;
      commitOutcomeUnknown?: true;
    }
  >();
  const requestAuditSink = options.durableRequestAuditSink;
  const factory = options.auditEventFactory ?? new AuditEventFactory();
  const readAgentAudit =
    options.agentAuditCursorSecret === undefined
      ? undefined
      : createAgentAuditReader(options.agentAuditCursorSecret);
  const createAuthAccountOperation = installationAuthOperation({
    operationId: "createAuthAccount",
    method: "POST",
    path: "/api/auth/accounts",
    action: "openclaw.auth.accounts.create",
    summary: "Create a local auth account as an Installation administrator",
  });
  const serviceKeyOperations = (
    [
      {
        operationId: "createServiceKey",
        method: "POST",
        path: "/api/auth/service-keys",
        action: "openclaw.auth.service-keys.create",
        summary: "Issue a service API key",
      },
      {
        operationId: "revokeServiceKey",
        method: "DELETE",
        path: "/api/auth/service-keys/:keyId",
        action: "openclaw.auth.service-keys.revoke",
        summary: "Revoke a service API key",
      },
    ] as const
  ).map(installationAuthOperation);
  const runtimeLogLimiter = new RuntimeLogLimiter();
  const runtimeLogCursor =
    options.agentRuntimeLogs?.enabled === true
      ? createRuntimeLogCursorCodec(options.agentRuntimeLogs.cursorSecret)
      : undefined;
  function event(
    operation: RequestOperation,
    request: FastifyRequest,
    resource: ResourceRef,
    kind: AuditEventKind,
    context?: RequestContext,
    evidence?: AuthorizationEvidence,
    result?: {
      readonly outcome: "success" | "denied" | "failure";
      readonly reasonCode?: string;
      // A route's own denial explanation. It passes through the factory with the rest of the
      // event, so its reason is redacted and capped and its details are redacted.
      readonly decisionReason?: string;
      readonly details?: Readonly<Record<string, unknown>>;
    },
    authorization?: NonNullable<AuthorizationDeniedError["authorization"]>,
    validatedAuthorization?: Readonly<DeployAgentAuthorization>,
  ): AuditEvent {
    const authorizationEvidence = validatedAuthorization?.decision.evidence ?? evidence;
    const outcome = result?.outcome ?? (kind === "authorization_denial" ? "denied" : "success");
    const evidenceDetails =
      context === undefined || authorizationEvidence === undefined
        ? undefined
        : {
            iamEvidence: {
              ...(authorizationEvidence.identityId === undefined
                ? {}
                : { identityId: authorizationEvidence.identityId }),
              groupIds: authorizationEvidence.groupIds,
              bindingIds: authorizationEvidence.bindingIds,
              roleIds: authorizationEvidence.roleIds,
              restrictionIds: authorizationEvidence.restrictionIds,
            },
          };
    // A request admitted by a service key names that key (its non-secret ID), so an
    // administrator can tell which of a ServicePrincipal's keys acted. `serviceKeyId` stays
    // the key a key-management event acts on.
    const admitted = admissions.get(request);
    const actorKeyDetails =
      admitted?.method === "api_key" && admitted.serviceKeyId !== undefined
        ? { actorServiceKeyId: admitted.serviceKeyId }
        : undefined;
    const details =
      result?.details === undefined && actorKeyDetails === undefined
        ? evidenceDetails
        : { ...evidenceDetails, ...result?.details, ...actorKeyDetails };
    return factory.create({
      installationId,
      ...(resource.namespaceId === undefined ? {} : { namespaceId: resource.namespaceId }),
      kind,
      source: "occ",
      requestId: request.id,
      ...(context === undefined
        ? { actor: { unresolved: true } }
        : {
            actor: {
              principalId: context.actorId,
              issuer: context.issuer,
              subject: context.subject,
            },
            admissionDecisionId: context.admissionDecisionId,
            iamDriverId: validatedAuthorization?.decision.driverId ?? selectedIAMDriver().id,
            authorization: validatedAuthorization?.request ?? {
              principalId: context.actorId,
              action: authorization?.action ?? operation.iamAction,
              // Namespace IAM policy routes are admitted by administer on the
              // Installation (plus reads), never by a Namespace administer check.
              resource:
                authorization?.resource ??
                (operation.authorizationTarget === "namespace_iam"
                  ? { kind: "installation", id: installationId }
                  : operationTarget(
                      operation,
                      installationId,
                      request.params as Record<string, unknown>,
                    )),
            },
            ...(authorizationEvidence === undefined
              ? {}
              : {
                  ...(outcome === "denied" && authorizationEvidence.restrictionIds.length > 0
                    ? { decisionReason: "A matching Restriction denied the operation." }
                    : {}),
                }),
          }),
      ...(result?.decisionReason === undefined ? {} : { decisionReason: result.decisionReason }),
      ...(details === undefined ? {} : { details }),
      action: auditAction(operation, request),
      resource,
      outcome,
      ...(result?.reasonCode === undefined
        ? kind === "authorization_denial"
          ? { reasonCode: "AUTHORIZATION_DENIED" }
          : {}
        : { reasonCode: result.reasonCode }),
    });
  }

  /** Log views and downloads share a route and permissions but not an audit action. */
  function auditAction(operation: RequestOperation, request: FastifyRequest): string {
    return operation.operationId === "getAgentDeploymentRuntimeLogs" &&
      isRuntimeLogDownload(request.query as AgentRuntimeLogsQuery)
      ? RUNTIME_LOG_DOWNLOAD_ACTION
      : operation.action;
  }

  function selectedIAMDriver(): IAMDriver {
    try {
      const selected =
        controller === undefined ? options.iamDriver : controller.selectedDriver("iam");
      if (selected.capability !== "iam") {
        throw new Error("Invalid authorization authority.");
      }
      return selected;
    } catch {
      throw dependencyUnavailable();
    }
  }

  function requireWorkspaceFileCsrf(request: FastifyRequest, requireOrigin: boolean): void {
    const admitted = admissions.get(request);
    if (admitted?.method === "api_key") {
      return;
    }
    const fetchSite = request.headers["sec-fetch-site"];
    const fetchSites =
      fetchSite === undefined ? [] : Array.isArray(fetchSite) ? fetchSite : [fetchSite];
    if (fetchSites.some((site) => site.toLowerCase() === "cross-site")) {
      throw failure(403, "FORBIDDEN", "The request did not satisfy the configured CSRF boundary.");
    }
    if (!requireOrigin) {
      return;
    }
    if (publicOrigin === undefined) {
      throw dependencyUnavailable();
    }
    const origin = request.headers.origin;
    if (typeof origin !== "string" || origin !== publicOrigin) {
      throw failure(403, "FORBIDDEN", "The request did not satisfy the configured CSRF boundary.");
    }
  }

  function pluginDiscoveryRequestSignal(reply: FastifyReply): AbortSignal {
    // The POST can finish parsing and its client disconnect while IAM resolves the caller.
    if (reply.raw.destroyed) {
      return AbortSignal.abort();
    }
    const disconnected = new AbortController();
    reply.raw.once("close", () => {
      if (!reply.raw.writableEnded) {
        disconnected.abort();
      }
    });
    return disconnected.signal;
  }

  async function requireInstallationAdmin(
    request: FastifyRequest,
    operation: RequestOperation,
    context: RequestContext,
  ) {
    const target: ResourceRef = { kind: "installation", id: installationId };
    const selected = selectedIAMDriver();
    const decision = await installationAdminDecision(selected, context.actorId, target);
    if (!decision.allowed) {
      await denial(operation, request, "authorization_denial", context, decision.evidence);
      throw failure(
        403,
        "FORBIDDEN",
        callerDenialMessage({ action: "administer", resource: target }),
      );
    }
    return { selected, target, decision };
  }

  async function installationAdminDecision(
    selected: IAMDriver,
    actorId: string,
    target: ResourceRef,
  ) {
    let decision;
    try {
      decision = await selected.authorize({
        principalId: actorId,
        action: "administer",
        resource: target,
      });
    } catch {
      throw dependencyUnavailable();
    }
    if (
      !decision ||
      typeof decision.allowed !== "boolean" ||
      typeof decision.reason !== "string" ||
      decision.driverId !== selected.id ||
      !validAuthorizationEvidence(decision.evidence)
    ) {
      throw dependencyUnavailable();
    }
    return decision;
  }

  // Report the primary IAM decision without auditing a mutation the caller never attempted.
  async function callerDecision(actorId: string, action: PermissionAction, resource: ResourceRef) {
    const selected = selectedIAMDriver();
    let decision;
    try {
      decision = await selected.authorize({ principalId: actorId, action, resource });
    } catch {
      throw dependencyUnavailable();
    }
    if (
      !decision ||
      typeof decision.allowed !== "boolean" ||
      typeof decision.reason !== "string" ||
      decision.driverId !== selected.id ||
      !validAuthorizationEvidence(decision.evidence)
    ) {
      throw dependencyUnavailable();
    }
    return { allowed: decision.allowed, restricted: decision.evidence.restrictionIds.length > 0 };
  }

  async function callerMay(
    actorId: string,
    action: PermissionAction,
    resource: ResourceRef,
  ): Promise<boolean> {
    return (await callerDecision(actorId, action, resource)).allowed;
  }

  async function denial(
    operation: RequestOperation,
    request: FastifyRequest,
    kind: "authorization_denial",
    context?: RequestContext,
    evidence?: AuthorizationEvidence,
    authorization?: NonNullable<AuthorizationDeniedError["authorization"]>,
    explanation?: {
      readonly decisionReason: string;
      readonly reasonCode?: string;
      readonly details: Readonly<Record<string, unknown>>;
      readonly requireAuditWrite?: true;
    },
  ): Promise<void> {
    const audit = requestAuditState.get(request);
    if (audit !== undefined) {
      audit.denialObserved = true;
    }
    try {
      // Chat has no Namespace path input, so it needs the stored Agent target.
      // Other operations keep the requested audit target, separate from enforcement.
      await options.auditSink.append(
        event(
          operation,
          request,
          operation.operationId === "chatWithAgent" && authorization !== undefined
            ? authorization.resource
            : operationTarget(operation, installationId, request.params as Record<string, unknown>),
          kind,
          context,
          evidence,
          explanation === undefined ? undefined : { outcome: "denied", ...explanation },
          authorization,
        ),
      );
    } catch (error) {
      if (audit !== undefined && controller !== undefined) {
        logRequestAuditFailure(request, operation, auditAction(operation, request), error);
        if (explanation?.requireAuditWrite !== true) {
          return;
        }
      }
      throw dependencyUnavailable();
    }
  }

  async function rejectedMutation(
    operation: RequestOperation,
    request: FastifyRequest,
    context: RequestContext,
    reasonCode: string,
  ): Promise<void> {
    try {
      await options.auditSink.append(
        event(
          operation,
          request,
          operationTarget(operation, installationId, request.params as Record<string, unknown>),
          "mutation",
          context,
          undefined,
          { outcome: "failure", reasonCode },
        ),
      );
    } catch (error) {
      if (requestAuditState.has(request) && controller !== undefined) {
        logRequestAuditFailure(request, operation, auditAction(operation, request), error);
        return;
      }
      throw dependencyUnavailable();
    }
  }

  function logRequestAuditFailure(
    request: FastifyRequest,
    operation: RequestOperation,
    action: string,
    error: unknown,
  ): void {
    let code = "AUDIT_WRITE_FAILED";
    if (error instanceof PostgresCommitOutcomeUnknownError) {
      code = "AUDIT_COMMIT_OUTCOME_UNKNOWN";
    } else if (error instanceof AuditAppendUnavailableError && error.reasonCode !== undefined) {
      code = error.reasonCode;
    }
    app.log.error({
      event: "http.audit_append_failed",
      requestId: request.id,
      action,
      operationId: operation.operationId,
      code,
    });
  }

  async function appendRequestAudit(
    sink: AuditSink,
    request: FastifyRequest,
    operation: RequestOperation,
    observation: ApiRequestAuditObservation,
  ): Promise<boolean> {
    const context = contexts.get(request);
    const resource: ResourceRef = ("readTarget" in observation
      ? observation.readTarget
      : undefined) ?? { kind: "installation", id: installationId };
    try {
      await sink.append(
        factory.create({
          installationId,
          ...(resource.namespaceId === undefined ? {} : { namespaceId: resource.namespaceId }),
          kind: "api_request",
          action: observation.action,
          outcome: observation.outcome,
          resource,
          actor: context === undefined ? { unresolved: true } : { principalId: context.actorId },
          requestId: request.id,
          ...(context === undefined ? {} : { admissionDecisionId: context.admissionDecisionId }),
          ...("reasonCode" in observation ? { reasonCode: observation.reasonCode } : {}),
          details: {
            operationId: operation.operationId,
            method: request.method === "HEAD" ? "HEAD" : operation.method,
            ...("statusCode" in observation ? { statusCode: observation.statusCode } : {}),
          },
        }),
      );
      return true;
    } catch (error) {
      logRequestAuditFailure(request, operation, observation.action, error);
      return false;
    }
  }

  function setAuditReadTarget(request: FastifyRequest, resource: ResourceRef): void {
    const audit = requestAuditState.get(request);
    if (audit !== undefined) {
      audit.readTarget = resource;
    }
  }

  const nativeAdmin = createNativeAdminAccess({
    app,
    installationId,
    publicOrigin,
    factory,
    getController: () => controller,
    selectedIAMDriver,
    getContext: (request) => contexts.get(request),
    getAdmission: (request) => admissions.get(request),
    auth: options.auth,
    nativeAdmin: options.nativeAdmin,
    nativeAdminGatewayApiKey: options.nativeAdminGatewayApiKey,
    webSocketLeaseIntervalMs: nativeAdminWebSocketLeaseIntervalMs,
    auditSink: options.auditSink,
  });

  const connectionOrigin = publicOrigin ?? browserOrigin?.origin;
  const connectionRedirectUri =
    connectionOrigin && `${connectionOrigin}${CONNECTION_CALLBACK_PATH}`;
  const handlers: ResourceHandlers = {
    ...namespaceConnectionHandlers(connectionRedirectUri),
    ...resourceHandlers,
    ...sandboxPolicyHandlers,
    ...createAgentHandlers({
      nativeAdmin: options.nativeAdmin,
      publicOrigin,
      installationId,
      resolveHarness: options.resolveHarness,
      requireCredentialCsrf: (request) => requireWorkspaceFileCsrf(request, true),
      rejectDeployment: (request, context) =>
        rejectedMutation(context.operation, request, context, "NAMESPACE_NOT_READY"),
    }),
    ...createWorkspaceFileHandlers({
      access: options.workspaceFilesAccess,
      timeoutMs: workspaceFileRequestTimeoutMs,
      auditSink: options.auditSink,
      requireCsrf: requireWorkspaceFileCsrf,
      isAuditManaged: (request) => requestAuditState.has(request),
      logAuditFailure: (request, operation, error) =>
        logRequestAuditFailure(request, operation, operation.action, error),
    }),
  };

  const chatBodyDeadlines = new WeakMap<FastifyRequest, ReturnType<typeof setTimeout>>();
  app.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions.url === "/agents/:agentId/chat") {
      const timer = setTimeout(() => {
        if (!reply.sent) {
          reply.header("connection", "close");
          reply.raw.once("finish", () => request.raw.destroy());
          void reply.code(408).send({
            error: { code: "REQUEST_TIMEOUT", message: "The request body deadline expired." },
            meta: { requestId: request.id },
          });
        }
      }, 60_000);
      chatBodyDeadlines.set(request, timer);
      request.raw.once("end", () => clearTimeout(timer));
      request.raw.once("aborted", () => clearTimeout(timer));
    }
    requestStartedAt.set(request, process.hrtime.bigint());
    responseHeaders(reply, request.id);
    if (await nativeAdmin.interceptHttp(request, reply)) {
      return;
    }
    if ("auditManagementRequest" in request.routeOptions.config) {
      requestAuditState.set(request, { denialObserved: false, resultSelected: false });
    }
    const contentLength = request.headers["content-length"];
    if (
      typeof contentLength === "string" &&
      Number(contentLength) > (request.routeOptions.bodyLimit ?? bodyLimit)
    ) {
      throw failure(413, "PAYLOAD_TOO_LARGE", "The request body exceeds the permitted size.");
    }
  });

  app.addHook("onResponse", async (request, reply) => {
    clearTimeout(chatBodyDeadlines.get(request));
    const startedAt = requestStartedAt.get(request);
    const durationMs =
      startedAt === undefined ? undefined : Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    if (durationMs !== undefined) {
      options.metrics?.observeHttp(
        request.routeOptions.url ?? "unmatched",
        request.method,
        reply.statusCode,
        durationMs / 1000,
      );
    }
    app.log.info({
      event: "http.completed",
      requestId: request.id,
      method: request.method,
      route: request.routeOptions.url ?? "unmatched",
      status: reply.statusCode,
      nativeAdmissionReason: nativeAdmin.httpAdmissionReason(request),
      ...(durationMs === undefined ? {} : { durationMs: Math.round(durationMs * 1000) / 1000 }),
    });
  });

  // A proxy that adds forwarded headers, with api.trustedProxy unset or not covering it,
  // makes every API call fail with 403 while sign-in still works. Tell the operator why, at
  // most once a minute; the record names the cause only, never an address.
  let forwardedRefusalWarnedAt: number | undefined;
  function warnForwardedRefusal(): void {
    const now = performance.now();
    if (forwardedRefusalWarnedAt !== undefined && now - forwardedRefusalWarnedAt < 60_000) {
      return;
    }
    forwardedRefusalWarnedAt = now;
    options.logger?.warn({
      event: "authentication.forwarded-refused-warning",
      code:
        options.trustedProxies === undefined
          ? "TRUSTED_PROXY_NOT_CONFIGURED"
          : "TRUSTED_PROXY_PEER_UNTRUSTED",
    });
  }

  async function admit(request: FastifyRequest, operation: RequestOperation): Promise<void> {
    if (
      request.headers[OCC_SERVICE_KEY_HEADER] !== undefined &&
      (operation === createAuthAccountOperation ||
        operation.operationId === "bootstrapInstallation" ||
        operation.operationId === "listAgentAuditEvents")
    ) {
      throw failure(401, "UNAUTHENTICATED", "A human controller session is required.");
    }
    const params = request.params as Record<string, unknown>;
    if (
      Object.keys(request.query as Record<string, unknown>).length > 0 &&
      operation.operationId !== "listRepositoryOptions" &&
      operation.operationId !== "listAgentRepositoryOptions" &&
      operation.operationId !== "getAgentDeploymentRuntimeLogs" &&
      operation.operationId !== "deleteServiceAccount" &&
      operation.operationId !== "stopAgent" &&
      operation.operationId !== "listAgentRevisions" &&
      operation.operationId !== "listAgentAuditEvents" &&
      operation.operationId !== "recoverAgentFirstDeployment" &&
      operation !== connectionCallbackOperation
    ) {
      throw failure(
        400,
        "INVALID_REQUEST",
        "The request does not match the operation contract: this operation accepts no query parameters.",
      );
    }
    for (const [parameter, pattern] of Object.entries(RESOURCE_ID)) {
      if (
        params[parameter] !== undefined &&
        (typeof params[parameter] !== "string" || !pattern.test(params[parameter] as string))
      ) {
        // Names the path parameter and its syntax only; nothing about any stored resource.
        const prefix = RESOURCE_ID_PREFIX[parameter as keyof typeof RESOURCE_ID_PREFIX];
        throw failure(
          400,
          "INVALID_REQUEST",
          `The request does not match the operation contract: params /${parameter} has an invalid format; expected ${prefix} followed by a lowercase version 4 UUID.`,
          [{ path: `/${parameter}`, code: "INVALID_FORMAT" }],
        );
      }
    }

    const host = request.headers.host;
    let hostname: string;
    let requestHost: string;
    try {
      const parsed = new URL(`http://${host ?? "127.0.0.1"}`);
      hostname = parsed.hostname;
      requestHost = parsed.host;
    } catch {
      hostname = "";
      requestHost = "";
    }
    const remoteAddress = request.raw.socket.remoteAddress ?? "127.0.0.1";
    const origin = request.headers.origin;
    let originAllowed = true;
    if (typeof origin === "string") {
      try {
        originAllowed = LOOPBACK_HOSTNAMES.has(new URL(origin).hostname);
      } catch {
        originAllowed = false;
      }
    } else if (Array.isArray(origin)) {
      originAllowed = false;
    }
    const browserEndpointAllowed =
      browserOrigin !== undefined &&
      requestHost === browserOrigin.host &&
      (origin === undefined || origin === browserOrigin.origin);
    // Forwarded headers are never used for admission. They are tolerated only from a
    // configured trusted proxy, which adds them to every request it relays.
    const forwarded =
      options.trustedProxies?.trusts(remoteAddress) !== true &&
      Object.keys(request.headers).some(
        (name) => name === "forwarded" || name === "x-real-ip" || name.startsWith("x-forwarded-"),
      );
    if (forwarded && !development.enabled) {
      warnForwardedRefusal();
    }
    if (
      forwarded ||
      (development.enabled &&
        (((!LOOPBACK_HOSTNAMES.has(hostname) || !originAllowed) && !browserEndpointAllowed) ||
          !trustedDevelopmentAddress(development, remoteAddress)))
    ) {
      throw failure(
        403,
        "FORBIDDEN",
        development.enabled
          ? "Development admission is restricted to direct loopback requests."
          : "Production admission requires a direct request or forwarded headers from a configured trusted proxy.",
      );
    }

    let admitted: AdmittedCaller;
    try {
      admitted = await options.auth.admissionVerifier.verifyControllerRequest({
        requestId: request.id,
        method: request.method,
        routeId: operation.operationId,
        ...(request.routeOptions.url === undefined ? {} : { route: request.routeOptions.url }),
        requestedScope: {
          installationId,
          ...(typeof params.namespaceId === "string" ? { namespaceId: params.namespaceId } : {}),
        },
        transport: {
          remoteAddress,
          ...(request.raw.socket.localAddress === undefined
            ? {}
            : { localAddress: request.raw.socket.localAddress }),
          trustProxy: false,
        },
        ...(typeof request.headers.authorization === "string"
          ? { authorizationHeader: request.headers.authorization }
          : {}),
        headers: request.headers,
      });
    } catch (error) {
      throw requestFailure(error);
    }

    if (
      !admitted ||
      !isNonEmptyString(admitted.externalIdentity?.issuer) ||
      !isNonEmptyString(admitted.externalIdentity?.subject) ||
      !isNonEmptyString(admitted.decisionId) ||
      (admitted.method !== "session" && admitted.method !== "api_key") ||
      admitted.admittedScope?.installationId !== installationId ||
      (admitted.method === "session" &&
        admitted.admittedScope.namespaceId !== undefined &&
        admitted.admittedScope.namespaceId !== params.namespaceId)
    ) {
      await denial(operation, request, "authorization_denial");
      throw dependencyUnavailable();
    }

    admissions.set(request, admitted);
  }

  async function resolveIdentity(
    request: FastifyRequest,
    operation: RequestOperation,
  ): Promise<void> {
    const admitted = admissions.get(request);
    if (!admitted) {
      throw dependencyUnavailable();
    }
    let selected: IAMDriver;
    let identity;
    try {
      selected = selectedIAMDriver();
      identity = await selected.lookupIdentity(
        admitted.method === "api_key"
          ? {
              servicePrincipalId: admitted.externalIdentity.subject,
              ...(admitted.admittedScope.namespaceId === undefined
                ? {}
                : { namespaceId: admitted.admittedScope.namespaceId }),
            }
          : {
              issuer: admitted.externalIdentity.issuer,
              subject: admitted.externalIdentity.subject,
            },
      );
    } catch {
      throw dependencyUnavailable();
    }

    if (
      !identity ||
      (admitted.method === "api_key"
        ? identity.kind !== "service_principal" ||
          identity.agentId !== undefined ||
          identity.id !== admitted.externalIdentity.subject ||
          identity.namespaceId !== admitted.admittedScope.namespaceId
        : identity.kind !== "principal" ||
          identity.issuer !== admitted.externalIdentity.issuer ||
          identity.subject !== admitted.externalIdentity.subject)
    ) {
      await denial(operation, request, "authorization_denial");
      throw failure(403, "FORBIDDEN", GENERIC_DENIAL);
    }

    const context: RequestContext = {
      actorId: identity.id,
      ...(admitted.method === "session" && { sessionId: admitted.session.id }),
      issuer: admitted.externalIdentity.issuer,
      subject: admitted.externalIdentity.subject,
      admissionDecisionId: admitted.decisionId,
      operation,
    };
    contexts.set(request, context);
    if (
      admitted.method === "api_key" &&
      operation.operationId !== "chatWithAgent" &&
      admitted.admittedScope.namespaceId !== undefined &&
      admitted.admittedScope.namespaceId !== (request.params as Record<string, unknown>).namespaceId
    ) {
      await denial(operation, request, "authorization_denial", context);
      // Names only the key's own Namespace, never the requested one (finding D763).
      throw failure(
        403,
        "FORBIDDEN",
        `This service key works only in Namespace ${admitted.admittedScope.namespaceId}; this request is outside it. Ask an Installation administrator to run it.`,
      );
    }
  }

  /**
   * Preset and Configuration writes accept bodies of about 6 MiB (PRESET_BODY_LIMIT,
   * CONFIGURATION_BODY_LIMIT), far above the general limit. Their grant check needs only the
   * path and the caller, so it runs here, in onRequest, before the body is read: a caller
   * without the grant gets the same 403 or 404 and audit row as when the check ran in the
   * handler, and the controller never buffers the body. The handler repeats the check in its
   * transaction, with the Secret binding checks that need the body.
   */
  async function authorizeBeforeBody(request: FastifyRequest, operation: OccApiRoute) {
    const context = contexts.get(request);
    if (!context) {
      throw dependencyUnavailable();
    }
    if (!controller) {
      throw failure(404, "NOT_FOUND", "The requested platform resource was not found.");
    }
    const params = request.params as Record<string, string>;
    if (
      operation.operationId === "createConfiguration" ||
      operation.operationId === "updateConfiguration"
    ) {
      await controller.authorizeConfigurationWrite(
        context.actorId,
        params.namespaceId as string,
        operation.operationId === "updateConfiguration" ? params.configurationId : undefined,
      );
      return;
    }
    await controller.authorizePresetWrite(
      context.actorId,
      params.namespaceId as string,
      operation.operationId === "updatePreset" ? params.presetId : undefined,
    );
  }

  // Each OCC transaction that writes durable authority (an Owner binding or deploy-time grants)
  // holds a session caller's session through COMMIT, as Namespace policy writes do (#2311), so a
  // sign-out or account disable cannot commit in between. Other work runs unchanged.
  function performFenced(
    request: FastifyRequest,
    reply: FastifyReply,
    operation: OccApiRoute,
  ): Promise<void> {
    const admitted = admissions.get(request);
    if (
      operation.operationId === "chatWithAgent" ||
      controller === undefined ||
      admitted?.method !== "session"
    ) {
      return perform(request, reply, operation);
    }
    const { session } = admitted;
    return controller.withAuthorityFence(
      (unit) => options.auth.holdSession(unit, session, request),
      () => perform(request, reply, operation),
    );
  }

  async function perform(
    request: FastifyRequest,
    reply: FastifyReply,
    operation: OccApiRoute,
  ): Promise<void> {
    const context = contexts.get(request);
    if (!context) {
      throw dependencyUnavailable();
    }
    if (operation.operationId === "chatWithAgent") {
      const admission = admissions.get(request);
      if (controller === undefined || admission === undefined) {
        throw dependencyUnavailable();
      }
      return relayAgentChat({
        installationId,
        controller,
        request,
        reply,
        context,
        admission,
        factory,
        auditSink: options.auditSink,
        gatewayApiKey: options.nativeAdminGatewayApiKey,
        auditFailure: (error) =>
          logRequestAuditFailure(request, operation, operation.action, error),
        reauthenticate: async () => {
          await admit(request, operation);
          await resolveIdentity(request, operation);
          if (contexts.get(request)?.actorId !== context.actorId) {
            throw dependencyUnavailable();
          }
        },
      });
    }
    const params = request.params as Record<string, string>;
    const body = request.body as Record<string, unknown> | undefined;
    if (body !== undefined) {
      validateConfiguration(body);
    }

    // TODO(RFC-0034): Remove this guard when the ModelProvider implementation is available.
    if (
      (body &&
        "modelProviderId" in body &&
        ["createAgent", "provisionAgent", "validateAgentCreate", "updateAgent"].includes(
          operation.operationId,
        )) ||
      [
        "listModelProviders",
        "getModelProvider",
        "createModelProvider",
        "updateModelProvider",
        "listUsableModelProviders",
      ].includes(operation.operationId)
    ) {
      throw failure(
        501,
        "NOT_IMPLEMENTED",
        "Named model providers are unavailable on this controller.",
      );
    }

    if (operation.operationId === "bootstrapInstallation") {
      if (controller || bootstrapping) {
        throw failure(409, "INSTALLATION_EXISTS", "The deployment already owns an Installation.");
      }
      bootstrapping = true;
      try {
        const { selected, target, decision } = await requireInstallationAdmin(
          request,
          operation,
          context,
        );
        if (!options.createController) {
          throw dependencyUnavailable();
        }
        const installation: Installation = {
          id: installationId,
          name: body?.name as string,
          createdAt: new Date().toISOString(),
        };
        const created = options.createController(installation);
        created.registerDriver(selected);
        created.selectDriver("iam", selected.id);
        if (options.computeDriver) {
          created.registerDriver(options.computeDriver);
          created.selectDriver("compute", options.computeDriver.id);
        }
        if (options.configurationDriver) {
          created.registerDriver(options.configurationDriver);
          created.selectDriver("configuration", options.configurationDriver.id);
        }
        if (options.secretDriver) {
          created.registerDriver(options.secretDriver);
          created.selectDriver("secret", options.secretDriver.id);
        }
        if (options.channelDriver) {
          created.registerDriver(options.channelDriver);
          created.selectDriver("channel", options.channelDriver.id);
        }
        if (options.sandboxDriver) {
          created.registerDriver(options.sandboxDriver);
          created.selectDriver("sandbox", options.sandboxDriver.id);
        }
        await created.transact(async (unit) => {
          await createBootstrapResources(created, context.actorId);
          await unit.audit.append(
            event(operation, request, target, "bootstrap", context, decision.evidence),
          );
        });
        await created.applyIAMConfiguration();
        controller = created;
        reply.status(201).send({
          data: clientInstallation(
            created.installation,
            options.computeDriver,
            options.nativeAdmin?.enabled === true,
          ),
          meta: { requestId: request.id },
        });
        return;
      } finally {
        bootstrapping = false;
      }
    }

    if (!controller) {
      throw failure(404, "NOT_FOUND", "The requested platform resource was not found.");
    }

    if (operation.operationId === "discoverInstallationConfigurations") {
      const configurations = await controller.discoverConfigurations(context.actorId, {
        scope: "installation",
      });
      reply.send({ data: { configurations }, meta: { requestId: request.id } });
      return;
    }

    const templateHandler = connectionTemplateHandlers[operation.operationId];
    if (templateHandler) {
      const admitted = admissions.get(request);
      if (!admitted) {
        throw failure(503, "DEPENDENCY_UNAVAILABLE", "The request admission is unavailable.");
      }
      const session = admitted.method === "session" ? admitted.session : undefined;
      const run = () =>
        templateHandler({
          ...(session && {
            holdSession: (unit: PlatformUnitOfWork) =>
              options.auth.holdSession(unit, session, request),
          }),
          meta: {
            requestId: request.id,
            ...(connectionRedirectUri ? { redirectUri: connectionRedirectUri } : {}),
          },
          discover: options.discoverMcpAuthorization ?? discoverMcpAuthorization,
          controller: controller!,
          actorId: context.actorId,
          request,
          reply,
          mutationEvent: (resourceId) =>
            event(
              operation,
              request,
              { kind: "installation", id: installationId },
              "mutation",
              context,
              undefined,
              {
                outcome: "success",
                details: resourceId.startsWith("ccr_")
                  ? { oauthClientId: resourceId }
                  : { connectionTemplateId: resourceId },
              },
            ),
        });
      if (
        session &&
        operation.method !== "GET" &&
        operation.operationId !== "discoverConnectionTemplate"
      ) {
        await options.auth.withSessionAuthority(session, run);
      } else {
        await run();
      }
      return;
    }

    if (operation.operationId === "getInstallation") {
      reply.send({
        data: clientInstallation(
          await controller.getInstallation(context.actorId),
          options.computeDriver,
          options.nativeAdmin?.enabled === true,
        ),
        meta: { requestId: request.id },
      });
      return;
    }

    if (operation.operationId === "getInstallationDeploymentInventory") {
      reply.send({
        data: await controller.getInstallationDeploymentInventory(context.actorId),
        meta: { requestId: request.id },
      });
      return;
    }

    if (operation.operationId === "listBackends") {
      await requireInstallationAdmin(request, operation, context);
      const backends = options.backendSummaries;
      if (backends === undefined) {
        throw dependencyUnavailable();
      }
      reply.send({
        data: backends.map((backend) => ({ id: backend.id, type: backend.type })),
        meta: { requestId: request.id },
      });
      return;
    }

    if (operation.operationId === "getObservability") {
      await requireInstallationAdmin(request, operation, context);
      reply.send({
        data: { url: options.observabilityUrl ?? null },
        meta: { requestId: request.id },
      });
      return;
    }

    if (operation.operationId === "createNamespace") {
      const namespace = await controller.transact(async (unit) => {
        const created = await controller!.createNamespace(context.actorId, {
          name: body?.name as string,
          ...(body?.existingNamespace === undefined
            ? {}
            : { existingNamespace: body.existingNamespace as string }),
        });
        const target: ResourceRef = {
          kind: "namespace",
          id: created.id,
          namespaceId: created.id,
        };
        await unit.audit.append(event(operation, request, target, "mutation", context));
        return created;
      });
      reply.status(201).send({ data: namespace, meta: { requestId: request.id } });
      return;
    }

    if (operation.operationId === "listNamespaces") {
      reply.send({
        data: await controller.listNamespaces(context.actorId),
        meta: { requestId: request.id },
      });
      return;
    }

    const namespaceId = params.namespaceId;
    if (!namespaceId) {
      throw failure(400, "INVALID_REQUEST", "The request does not match the operation contract.");
    }
    if (operation.operationId === "getNamespace") {
      const namespace = await controller.getNamespace(context.actorId, namespaceId);
      setAuditReadTarget(request, {
        kind: "namespace",
        id: namespace.id,
        namespaceId: namespace.id,
      });
      reply.send({
        data: namespace,
        meta: { requestId: request.id },
      });
      return;
    }

    if (operation.operationId === "getNamespaceAgentCapabilities") {
      reply.send({
        data: {
          capabilities: {
            ...(await controller.getNamespaceAgentCapabilities(context.actorId, namespaceId)),
            ...(options.nativeAdmin?.enabled ? { nativeAdmin: true } : {}),
          },
        },
        meta: { requestId: request.id },
      });
      return;
    }

    if (
      operation.operationId === "getNamespaceCallerPermissions" ||
      operation.operationId === "getNamespaceSecretPermissions"
    ) {
      const data = await permissionAdvice[operation.operationId]({
        controller,
        actorId: context.actorId,
        namespaceId,
        installationId,
        callerMay,
      });
      reply.send({ data, meta: { requestId: request.id } });
      return;
    }

    if (operation.operationId === "deleteNamespace") {
      const namespace = await controller.transact(async (unit) => {
        const deleting = await controller!.deleteNamespace(context.actorId, namespaceId);
        await unit.audit.append(
          event(
            operation,
            request,
            {
              kind: "namespace",
              id: deleting.id,
              namespaceId: deleting.id,
            },
            "mutation",
            context,
          ),
        );
        return deleting;
      });
      reply.status(202).send({ data: namespace, meta: { requestId: request.id } });
      return;
    }

    if (
      operation.operationId === "startAgentDeviceAuthorization" ||
      operation.operationId === "startSavedAgentDeviceAuthorization" ||
      operation.operationId === "pollAgentDeviceAuthorization" ||
      operation.operationId === "pollSavedAgentDeviceAuthorization" ||
      operation.operationId === "cancelAgentDeviceAuthorization" ||
      operation.operationId === "cancelSavedAgentDeviceAuthorization"
    ) {
      const agentId = params.agentId;
      let result;
      if (operation.operationId.startsWith("start")) {
        result = await controller.startAgentDeviceAuthorization(
          context.actorId,
          namespaceId,
          body?.harnessId as string,
          agentId,
          (source, phase) =>
            event(
              operation,
              request,
              phase === "session_pending"
                ? { kind: "agent", id: agentId ?? namespaceId, namespaceId }
                : source.ref,
              "mutation",
              context,
              undefined,
              { outcome: "success", details: { phase, sourceId: source.id } },
            ),
        );
      } else if (operation.operationId.startsWith("poll")) {
        result = await controller.pollAgentDeviceAuthorization(
          context.actorId,
          namespaceId,
          params.sessionId as string,
          agentId,
        );
      } else {
        await controller.cancelAgentDeviceAuthorization(
          context.actorId,
          namespaceId,
          params.sessionId as string,
          agentId,
        );
      }
      // Clients poll on the provider interval; audit the transition, not every pending poll.
      if (!operation.operationId.startsWith("start") && result?.status !== "pending") {
        await options.auditSink.append(
          event(
            operation,
            request,
            { kind: "agent", id: agentId ?? namespaceId, namespaceId },
            "mutation",
            context,
          ),
        );
      }
      reply.header("cache-control", "no-store");
      if (result === undefined) {
        reply.status(204).send();
      } else {
        reply.send({ data: result, meta: { requestId: request.id } });
      }
      return;
    }

    if (operation.operationId === "discoverAgentModels") {
      const models = await controller.discoverAgentModels(context.actorId, namespaceId, {
        provider: body?.provider as string,
        authMethod: body?.authMethod as "api_key" | "codex_pat",
        apiKey: body?.apiKey as string,
      });
      reply.header("cache-control", "no-store");
      reply.send({ data: models, meta: { requestId: request.id } });
      return;
    }

    if (
      operation.operationId === "discoverAgentPlugins" ||
      operation.operationId === "discoverAgentPluginDetails"
    ) {
      const input = {
        harnessId: body?.harnessId as "codex" | "openclaw",
        ...(body?.credentialSource === undefined
          ? {}
          : { credentialSource: body.credentialSource as CredentialSourceReference }),
        ...(body?.secretRef === undefined
          ? { accessToken: body?.accessToken as string }
          : { secretRef: body.secretRef as SecretReference }),
      };
      const result =
        operation.operationId === "discoverAgentPlugins"
          ? await controller.discoverAgentPlugins(
              context.actorId,
              namespaceId,
              {
                ...input,
                ...(body?.cursor === undefined ? {} : { cursor: body.cursor as string }),
                ...(body?.q === undefined ? {} : { q: body.q as string }),
              },
              pluginDiscoveryRequestSignal(reply),
            )
          : await controller.discoverAgentPluginDetails(
              context.actorId,
              namespaceId,
              { ...input, pluginId: body?.pluginId as string },
              pluginDiscoveryRequestSignal(reply),
            );
      reply.header("cache-control", "no-store");
      reply.send({ data: result, meta: { requestId: request.id } });
      return;
    }

    if (operation.operationId === "getSavedAgentPluginPolicyCapabilities") {
      const capabilities = await controller.getSavedAgentPluginPolicyCapabilities(
        context.actorId,
        namespaceId,
        params.agentId as string,
      );
      reply.header("cache-control", "no-store");
      reply.send({ data: capabilities, meta: { requestId: request.id } });
      return;
    }

    if (operation.operationId === "discoverSavedAgentPlugins") {
      const catalog = await controller.discoverSavedAgentPlugins(
        context.actorId,
        namespaceId,
        params.agentId as string,
        {
          ...(body?.credentialSource === undefined
            ? {}
            : { credentialSource: body.credentialSource as CredentialSourceReference }),
          ...(body?.cursor === undefined ? {} : { cursor: body.cursor as string }),
          ...(body?.q === undefined ? {} : { q: body.q as string }),
        },
        pluginDiscoveryRequestSignal(reply),
      );
      reply.header("cache-control", "no-store");
      reply.send({ data: catalog, meta: { requestId: request.id } });
      return;
    }

    if (operation.operationId === "discoverSavedAgentPluginDetails") {
      const plugin = await controller.discoverSavedAgentPluginDetails(
        context.actorId,
        namespaceId,
        params.agentId as string,
        body as DiscoverSavedAgentPluginDetailsBody,
        pluginDiscoveryRequestSignal(reply),
        options.readManagedMcpToolNames ?? listManagedMcpToolNames,
      );
      reply.header("cache-control", "no-store");
      reply.send({ data: plugin, meta: { requestId: request.id } });
      return;
    }

    if (operation.operationId === "lookupChannelDirectory") {
      const directory = await controller.lookupChannelDirectory(context.actorId, namespaceId, {
        secretId: body?.secretId as string,
        kind: body?.kind as "users" | "channels",
        ...(body?.query === undefined ? {} : { query: body.query as string }),
        ...(body?.cursor === undefined ? {} : { cursor: body.cursor as string }),
        ...(body?.ids === undefined ? {} : { ids: body.ids as string[] }),
        ...(body?.agentId === undefined ? {} : { agentId: body.agentId as string }),
        ...(body?.configurationId === undefined
          ? {}
          : { configurationId: body.configurationId as string }),
      });
      reply.header("cache-control", "no-store");
      reply.send({ data: directory, meta: { requestId: request.id } });
      return;
    }

    const resourceHandler = handlers[operation.operationId];
    if (resourceHandler) {
      await resourceHandler({
        controller,
        resolveHarness: options.resolveHarness,
        context,
        request,
        reply,
        params,
        body,
        namespaceId,
        setAuditReadTarget: (resource) => setAuditReadTarget(request, resource),
        callerMay: (action, resource) => callerMay(context.actorId, action, resource),
        transactIAM: async (work) => {
          const admitted = admissions.get(request);
          if (admitted === undefined) {
            throw failure(503, "DEPENDENCY_UNAVAILABLE", "The request admission is unavailable.");
          }
          if (admitted.method !== "session") {
            return controller!.transact(work);
          }
          return options.auth.withSessionAuthority(admitted.session, () =>
            controller!.transact(async (unit) => {
              await options.auth.holdSession(unit, admitted.session, request);
              const result = await work(unit);
              // Recheck the session after the protected policy and audit work.
              await options.auth.holdSession(unit, admitted.session, request);
              return result;
            }),
          );
        },
        mutationEvent: (resource, details, authorization, failure) => {
          const recorded = event(
            operation,
            request,
            resource,
            "mutation",
            context,
            undefined,
            failure === undefined
              ? undefined
              : { outcome: "failure", reasonCode: failure.reasonCode },
            undefined,
            authorization,
          );
          return details === undefined
            ? recorded
            : { ...recorded, details: { ...recorded.details, ...details } };
        },
      });
      return;
    }

    const agentId = params.agentId;
    if (!agentId) {
      throw failure(400, "INVALID_REQUEST", "The request does not match the operation contract.");
    }

    if (operation.operationId === "listAgentAuditEvents") {
      const admitted = admissions.get(request);
      if (admitted?.method !== "session") {
        throw failure(401, "UNAUTHENTICATED", "A human controller session is required.");
      }
      if (readAgentAudit === undefined) {
        throw failure(501, "NOT_IMPLEMENTED", "Agent audit is disabled.");
      }
      await readAgentAudit({
        controller,
        auth: options.auth,
        session: admitted.session,
        factory,
        actorId: context.actorId,
        admissionDecisionId: admitted.decisionId,
        namespaceId,
        agentId,
        request,
        reply,
      });
      return;
    }

    if (
      operation.operationId === "getAgentCallerPermissions" ||
      operation.operationId === "getAgentSecretPermissions"
    ) {
      const data = await permissionAdvice[operation.operationId]({
        controller,
        actorId: context.actorId,
        namespaceId,
        agentId,
        callerDecision,
        callerMay,
      });
      reply.send({ data, meta: { requestId: request.id } });
      return;
    }

    if (
      operation.operationId === "getAgentDeploymentRuntime" ||
      operation.operationId === "getAgentDeploymentRuntimeLogs"
    ) {
      if (runtimeLogCursor === undefined) {
        throw failure(
          501,
          "NOT_IMPLEMENTED",
          "Agent runtime status and logs are disabled for this Installation.",
        );
      }
      // Authorization comes first, inside the controller: a denied caller is refused (and
      // audited) without taking a token, and only authorized Driver reads are limited.
      const admitRead = <T>(read: () => Promise<T>): Promise<T> => {
        runtimeLogLimiter.admit(context.actorId, agentId);
        return runtimeLogLimiter.run(read);
      };
      // A client that disconnects cancels its Driver reads.
      const disconnected = new AbortController();
      const onClose = () => {
        if (!reply.raw.writableEnded) {
          disconnected.abort();
        }
      };
      reply.raw.once("close", onClose);
      if (request.raw.aborted || reply.raw.destroyed) {
        onClose();
      }
      try {
        if (operation.operationId === "getAgentDeploymentRuntime") {
          const description = await controller!.describeAgentRuntime(
            context.actorId,
            namespaceId,
            agentId,
            params.deploymentId as string,
            disconnected.signal,
            admitRead,
          );
          reply.send({ data: description, meta: { requestId: request.id } });
          return;
        }
        const target: ResourceRef = { kind: "agent", id: agentId, namespaceId };
        const query = request.query as AgentRuntimeLogsQuery;
        const download = isRuntimeLogDownload(query);
        // A download is a fresh snapshot; it never continues a follow view.
        if (download && query.cursor !== undefined) {
          throw failure(
            400,
            "INVALID_REQUEST",
            "The request does not match the operation contract: querystring /cursor cannot be combined with /download; a download always starts a new view.",
            [{ path: "/cursor", code: "INVALID_VALUE" }],
          );
        }
        const logQuery = runtimeLogQuery(query);
        const page = await controller!.readAgentRuntimeLogs(
          context.actorId,
          namespaceId,
          agentId,
          params.deploymentId as string,
          logQuery,
          {
            codec: runtimeLogCursor,
            signal: disconnected.signal,
            admitRead,
            // Once per view or download, before the first Driver read; failure means
            // no content.
            admitView: async (admission, grant) => {
              const base = event(
                operation,
                request,
                target,
                "access",
                context,
                undefined,
                undefined,
                { action: grant.action, resource: target },
              );
              await options.auditSink.append({
                ...base,
                details: { ...base.details, runtimeLogs: { ...admission } },
              });
            },
          },
        );
        if (download) {
          reply
            .header("content-type", "text/plain; charset=utf-8")
            .header(
              "content-disposition",
              `attachment; filename="${runtimeLogDownloadFileName(page, agentId, logQuery.previous)}"`,
            )
            .send(runtimeLogDownloadBody(page, agentId, logQuery.previous));
          return;
        }
        reply.send({ data: runtimeLogPageBody(page), meta: { requestId: request.id } });
        return;
      } finally {
        reply.raw.off("close", onClose);
      }
    }

    throw failure(404, "NOT_FOUND", "The requested platform resource was not found.");
  }

  void app.register(async (routes) => {
    const authSchemas = createAuthRouteSchemas();
    const { bodyErrors, envelope, error, responses } = authSchemas;
    // Refuse request text that cannot be stored unchanged, as on OCC API routes.
    const refuseUnstorableText = (request: FastifyRequest, body: unknown = request.body) => {
      const unstorable =
        unstorableTextFailure("params", request.params) ?? unstorableTextFailure("body", body);
      if (unstorable !== undefined) {
        throw unstorable;
      }
    };
    for (const operation of serviceKeyOperations) {
      const creating = operation.method === "POST";
      routes.route({
        method: operation.method,
        url: operation.path,
        schema: authSchemas.serviceKey(operation, RESOURCE_ID.namespaceId.source),
        onRequest: async (request) => admit(request, operation),
        preValidation: async (request) => refuseUnstorableText(request),
        preHandler: async (request) => resolveIdentity(request, operation),
        handler: async (request, reply) => {
          const context = contexts.get(request);
          if (!context) {
            throw dependencyUnavailable();
          }
          if (!controller) {
            throw failure(409, "RESOURCE_CONFLICT", "Bootstrap the Installation first.");
          }
          if (!creating && request.body !== undefined) {
            // The same wording as OCC's operations that take no body.
            throw failure(
              400,
              "INVALID_REQUEST",
              "The request does not match the operation contract: this operation accepts no request body.",
            );
          }
          const { selected, target, decision } = await requireInstallationAdmin(
            request,
            operation,
            context,
          );
          // Names the key acted on by ID and its non-secret name; never the credential.
          const audit = (key: { id: string; servicePrincipalId: string; name: string }) => {
            const base = event(operation, request, target, "mutation", context, decision.evidence);
            return {
              ...base,
              details: {
                ...base.details,
                serviceKeyId: key.id,
                serviceKeyName: key.name,
                servicePrincipalId: key.servicePrincipalId,
              },
            };
          };
          // Issuing or revoking a key acts with every grant of its ServicePrincipal, so the
          // caller must already hold all of them; Installation administer alone is not enough.
          const requireCoverage = async (servicePrincipalId: string) => {
            let covered;
            try {
              covered =
                typeof selected.coversIdentityAccess === "function" &&
                (await selected.coversIdentityAccess({
                  principalId: context.actorId,
                  targetIdentityId: servicePrincipalId,
                })) === true;
            } catch {
              throw dependencyUnavailable();
            }
            if (covered) {
              return;
            }
            try {
              await options.auditSink.append(
                event(
                  operation,
                  request,
                  target,
                  "authorization_denial",
                  context,
                  decision.evidence,
                  {
                    outcome: "denied",
                    reasonCode: "SERVICE_PRINCIPAL_GRANTS_NOT_COVERED",
                    decisionReason:
                      "The caller does not hold every grant of the target ServicePrincipal.",
                    details: {
                      servicePrincipalId,
                      ...(creating
                        ? {}
                        : { serviceKeyId: (request.params as { keyId: string }).keyId }),
                    },
                  },
                ),
              );
            } catch {
              throw dependencyUnavailable();
            }
            throw failure(
              403,
              "FORBIDDEN",
              "The caller does not hold every grant of the target ServicePrincipal.",
            );
          };
          if (creating) {
            const body = request.body as {
              servicePrincipalId: string;
              namespaceId?: string;
              name: string;
              expiresIn?: number;
            };
            let principal;
            try {
              principal = await selected.lookupIdentity({
                servicePrincipalId: body.servicePrincipalId,
                ...(body.namespaceId === undefined ? {} : { namespaceId: body.namespaceId }),
              });
            } catch {
              throw dependencyUnavailable();
            }
            if (
              !principal ||
              principal.kind !== "service_principal" ||
              principal.agentId !== undefined ||
              principal.id !== body.servicePrincipalId ||
              principal.namespaceId !== body.namespaceId
            ) {
              throw failure(
                400,
                "INVALID_REQUEST",
                "An existing non-Agent ServicePrincipal in the exact scope is required.",
              );
            }
            // A key carries all of its principal's grants; never issue beyond the caller's own.
            await requireCoverage(principal.id);
            let key;
            try {
              key = await options.auth.createServiceKey({
                principal,
                name: body.name,
                ...(body.expiresIn === undefined ? {} : { expiresIn: body.expiresIn }),
              });
              await options.auditSink.append(audit(key));
            } catch (error) {
              // Never return an unaudited credential; remove it if audit persistence fails.
              if (key) {
                await options.auth.revokeServiceKey(key).catch(() => {});
              }
              // The schema admitted this name, so a refusal is a contract mismatch, not an
              // outage: answer as the schema does for a name over its bound.
              if (error instanceof ServiceKeyNameRefused) {
                throw failure(
                  400,
                  "INVALID_REQUEST",
                  `The request does not match the operation contract: body /name is too long (expected at most ${SERVICE_KEY_NAME_MAX_LENGTH} characters).`,
                  [{ path: "/name", code: "TOO_LONG" }],
                );
              }
              throw dependencyUnavailable();
            }
            reply.status(201).send({ data: key, meta: { requestId: request.id } });
          } else {
            const { keyId } = request.params as { keyId: string };
            let key;
            try {
              key = await options.auth.getServiceKey(keyId);
            } catch {
              throw dependencyUnavailable();
            }
            if (!key) {
              throw failure(404, "NOT_FOUND", "The service API key was not found.");
            }
            // Revocation requires the same authority as issuance.
            await requireCoverage(key.servicePrincipalId);
            try {
              await options.auth.revokeServiceKey(key);
              await options.auditSink.append(audit(key));
            } catch {
              throw dependencyUnavailable();
            }
            reply.send({ data: { id: key.id, revoked: true }, meta: { requestId: request.id } });
          }
        },
      });
    }

    routes.get(
      "/api/auth/providers",
      {
        schema: {
          operationId: "getAuthProviders",
          summary: "List configured browser sign-in methods",
          tags: ["Authentication"],
          security: [],
          response: responses({
            type: "object",
            additionalProperties: false,
            required: ["google", "oidc", "password", "sessionBinding"],
            properties: {
              google: { type: "boolean" },
              oidc: { type: "boolean" },
              oidcSignIn: {
                type: "object",
                description:
                  "Present only when OIDC sign-in is configured: the Console's button label and the configured authorization endpoint that the start URL must use.",
                additionalProperties: false,
                required: ["label", "authorizationUrl"],
                properties: {
                  label: { type: "string", minLength: 1, maxLength: 40 },
                  authorizationUrl: { type: "string", format: "uri" },
                },
              },
              password: {
                type: "boolean",
                description:
                  "False when password sign-in is recovery-only: ordinary accounts sign in with an external provider, and only the recovery account uses a password.",
              },
              sessionBinding: { type: "boolean" },
            },
          }),
        },
      },
      async (request, reply) => {
        reply.header("cache-control", "no-store");
        const google = options.auth.googleEnabled === true;
        const oidc = options.auth.oidcEnabled === true;
        const password = options.auth.passwordSignIn !== "recovery-only";
        return {
          data: {
            google,
            oidc,
            ...(oidc && options.auth.oidcSignIn !== undefined
              ? { oidcSignIn: options.auth.oidcSignIn }
              : {}),
            password,
            sessionBinding: google || oidc,
          },
          meta: { requestId: request.id },
        };
      },
    );
    // Handlers resolve on each request, as before: options.auth is read lazily.
    const externalSignInProviders = [
      { name: "google", label: "Google", article: "a", operation: "Google" },
      { name: "oidc", label: "OIDC", article: "an", operation: "Oidc" },
    ] as const;
    for (const provider of externalSignInProviders) {
      routes.post(
        `/api/auth/providers/${provider.name}/start`,
        {
          schema: {
            operationId: `start${provider.operation}SignIn`,
            summary: `Start ${provider.label} sign-in for an enrolled account`,
            description:
              "Requires the exact configured browser Origin and, when Sec-Fetch-Site is present, same-origin. Creates a one-use browser-bound login attempt and returns its public attemptId for the result exchange; does not create an account or grant access.",
            tags: ["Authentication"],
            security: [],
            response: {
              ...responses({
                type: "object",
                additionalProperties: false,
                required: ["url", "attemptId"],
                properties: {
                  url: { type: "string", format: "uri" },
                  attemptId: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
                },
              }),
              403: { description: "Forbidden", ...error },
            },
          },
        },
        async (request, reply) => options.auth[`${provider.name}Start`](request, reply),
      );
      routes.get(
        `/api/auth/providers/${provider.name}/callback`,
        {
          schema: {
            operationId: `complete${provider.operation}SignIn`,
            summary: `Complete an enrolled ${provider.label} sign-in`,
            description:
              "Consumes the browser-bound attempt before provider exchange. Redirects to Console after session and audit commit or with a fixed failure classification.",
            tags: ["Authentication"],
            security: [],
            response: { 302: { description: "Redirect to Console", type: "null" } },
          },
        },
        async (request, reply) => options.auth[`${provider.name}Callback`](request, reply),
      );
      routes.post(
        `/api/auth/providers/${provider.name}/result`,
        {
          schema: {
            operationId: `confirm${provider.operation}SignIn`,
            summary: `Confirm which session ${provider.article} ${provider.label} sign-in created`,
            description:
              "Requires the configured browser Origin, the one-use login receipt cookie set by the callback, the matching attemptId and the session cookie that callback issued. Returns that session's sessionKey; never issues or extends a session.",
            tags: ["Authentication"],
            security: [{ sessionCookie: [] }],
            body: {
              type: "object",
              additionalProperties: false,
              required: ["attemptId"],
              properties: { attemptId: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" } },
            },
            response: {
              // A body without the exact attemptId fails the schema.
              400: { description: "Bad Request", ...error },
              ...responses({
                type: "object",
                additionalProperties: false,
                required: ["sessionKey"],
                properties: { sessionKey: { type: "string" } },
              }),
              403: { description: "Forbidden", ...error },
              ...bodyErrors,
            },
          },
        },
        async (request, reply) => options.auth[`${provider.name}Result`](request, reply),
      );
    }

    function accountAdmission(operation: RequestOperation) {
      return {
        onRequest: async (request: FastifyRequest) => admit(request, operation),
        preValidation: async (request: FastifyRequest) => {
          refuseUnstorableText(request);
          await resolveIdentity(request, operation);
        },
      };
    }

    const accountReadOperation = installationAuthOperation({
      operationId: "getAuthAccount",
      method: "GET",
      path: "/api/auth/accounts/:userId",
      action: "openclaw.auth.accounts.read",
      summary: "Inspect current human account state",
    });
    // Account state and its controls live in the guarded external sign-in profile; the
    // password-only profile has no account version, disabled state, or bound sessions.
    function accountControlsUnsupported(): RequestFailure {
      return failure(
        409,
        "RESOURCE_CONFLICT",
        "Account controls require Google or OIDC sign-in; the password-only profile does not support them.",
      );
    }
    async function humanAccountActor(
      request: FastifyRequest,
      operation: RequestOperation,
      context: RequestContext,
      targetUserId?: string,
    ) {
      const admitted = admissions.get(request);
      const origin = request.headers.origin;
      const fetchMode = request.headers["sec-fetch-mode"];
      // A browser GET from the Console omits Origin. Its Fetch Metadata is scoped
      // to the requested host, so match the configured Console authority as well.
      const sameOriginBrowserRead =
        request.method === "GET" &&
        origin === undefined &&
        request.headers.host?.toLowerCase() === publicOriginHost &&
        request.headers["sec-fetch-site"] === "same-origin" &&
        (fetchMode === "cors" || fetchMode === "same-origin") &&
        request.headers["sec-fetch-dest"] === "empty";
      if (
        admitted?.method !== "session" ||
        admitted.session.userId !== context.subject ||
        publicOrigin === undefined ||
        (origin !== publicOrigin && !sameOriginBrowserRead)
      ) {
        throw failure(
          403,
          "FORBIDDEN",
          "A current human session and trusted browser origin are required.",
        );
      }
      const { selected, decision } = await requireInstallationAdmin(request, operation, context);
      if (!(selected instanceof NativeIAMDriver)) {
        throw dependencyUnavailable();
      }
      // A change to an account acts for its Principal (an attached identity signs in as it), so
      // the actor must already hold every grant of that Principal, as for service keys.
      if (targetUserId !== undefined) {
        let principalId;
        let covered;
        try {
          const principal = await selected.lookupIdentity({
            issuer: options.auth.issuer,
            subject: targetUserId,
          });
          principalId = principal?.kind === "principal" ? principal.id : undefined;
          // Without a Principal the account is not enrolled, and State refuses the change.
          covered =
            principalId === undefined ||
            (await selected.coversIdentityAccess({
              principalId: context.actorId,
              targetIdentityId: principalId,
            })) === true;
        } catch {
          throw dependencyUnavailable();
        }
        if (!covered) {
          const decisionReason =
            "The caller does not hold every grant of the target account's Principal.";
          // The event's resource is the Installation, so name the account it targeted.
          await denial(
            operation,
            request,
            "authorization_denial",
            context,
            decision.evidence,
            undefined,
            {
              decisionReason,
              reasonCode: "ACCOUNT_PRINCIPAL_GRANTS_NOT_COVERED",
              details: { userId: targetUserId, principalId },
            },
          );
          throw failure(403, "FORBIDDEN", decisionReason);
        }
      }
      return {
        userId: admitted.session.userId,
        sessionId: admitted.session.id,
        principalId: context.actorId,
        authorize: async (scope: {
          readonly targetPrincipalId?: string;
          readonly successorPrincipalId?: string;
        }) => {
          // State invokes this after its locks, on the same transaction as the write.
          // Throw evidence back to the HTTP error handler; auditing here opens another unit.
          const resource: ResourceRef = { kind: "installation", id: installationId };
          let current;
          let covered = true;
          let successor;
          try {
            current = await selected.authorize({
              principalId: context.actorId,
              action: "administer",
              resource,
            });
            if (targetUserId !== undefined) {
              covered =
                scope.targetPrincipalId !== undefined &&
                (await selected.coversIdentityAccess({
                  principalId: context.actorId,
                  targetIdentityId: scope.targetPrincipalId,
                })) === true;
            }
            if (scope.successorPrincipalId !== undefined) {
              successor = await selected.authorize({
                principalId: scope.successorPrincipalId,
                action: "administer",
                resource,
              });
            }
          } catch {
            throw dependencyUnavailable();
          }
          if (
            typeof current.allowed !== "boolean" ||
            typeof current.reason !== "string" ||
            current.driverId !== selected.id ||
            !validAuthorizationEvidence(current.evidence)
          ) {
            throw dependencyUnavailable();
          }
          if (!current.allowed) {
            throw new AuthorizationDeniedError(
              current.reason,
              current.evidence,
              { action: "administer", resource },
              context.actorId,
            );
          }
          if (!covered) {
            throw new AccountPrincipalAccessDeniedError(
              targetUserId!,
              scope.targetPrincipalId!,
              current.evidence,
            );
          }
          if (scope.successorPrincipalId !== undefined) {
            if (
              successor === undefined ||
              typeof successor.allowed !== "boolean" ||
              typeof successor.reason !== "string" ||
              successor.driverId !== selected.id ||
              !validAuthorizationEvidence(successor.evidence)
            ) {
              throw dependencyUnavailable();
            }
            if (!successor.allowed) {
              throw new ResourceStateConflictError(
                "The recovery account must administer the Installation.",
              );
            }
          }
        },
      };
    }
    routes.get(
      accountReadOperation.path,
      {
        schema: authSchemas.readAccount(accountReadOperation),
        ...accountAdmission(accountReadOperation),
      },
      async (request, reply) => {
        const context = contexts.get(request);
        if (!context) {
          throw dependencyUnavailable();
        }
        const actor = await humanAccountActor(request, accountReadOperation, context);
        if (!options.auth.readAccount) {
          throw accountControlsUnsupported();
        }
        const { userId } = request.params as { userId: string };
        const account = await options.auth.readAccount(userId, actor);
        reply
          .header("cache-control", "no-store")
          .send({ data: account, meta: { requestId: request.id } });
      },
    );

    const accountOperations = [
      {
        operationName: "google",
        path: "/api/auth/accounts/:userId/providers/google",
        operationId: "attachGoogleIdentity",
        summary: "Attach an exact Google identity to an existing account",
      },
      {
        operationName: "oidc",
        path: "/api/auth/accounts/:userId/providers/oidc",
        operationId: "attachOidcIdentity",
        summary: "Attach an exact OIDC identity to an existing account",
      },
      {
        operationName: "disable",
        path: "/api/auth/accounts/:userId/disable",
        operationId: "disableAuthAccount",
        summary: "Disable a human account",
      },
      {
        operationName: "enable",
        path: "/api/auth/accounts/:userId/enable",
        operationId: "enableAuthAccount",
        summary: "Re-enable a disabled human account",
      },
      {
        operationName: "revoke",
        path: "/api/auth/accounts/:userId/revoke",
        operationId: "revokeAuthAccountSessions",
        summary: "Revoke all sessions for a human account",
      },
      {
        operationName: "detach",
        path: "/api/auth/accounts/:userId/methods/:methodId/detach",
        operationId: "detachAuthMethod",
        summary: "Detach an external sign-in identity from an account",
      },
    ] as const;
    for (const { operationName, path, operationId, summary } of accountOperations) {
      const operation = installationAuthOperation({
        operationId,
        method: "POST",
        path,
        action: `openclaw.auth.accounts.${operationName}`,
        summary,
      });
      routes.post(
        operation.path,
        {
          schema: authSchemas.changeAccount(operation, operationName),
          ...accountAdmission(operation),
        },
        async (request, reply) => {
          const context = contexts.get(request);
          if (!context) {
            throw dependencyUnavailable();
          }
          const { userId } = request.params as { userId: string };
          const actor = await humanAccountActor(request, operation, context, userId);
          if (!options.auth.readAccount || !options.auth.changeAccount) {
            throw accountControlsUnsupported();
          }
          const { expectedVersion } = request.body as { expectedVersion: number };
          if (operationName === "google") {
            if (!options.auth.attachGoogle || !options.auth.googleEnabled) {
              throw failure(409, "RESOURCE_CONFLICT", "Google sign-in is not configured.");
            }
            const { subject } = request.body as { subject: string };
            await options.auth.attachGoogle(userId, subject, actor, expectedVersion);
          } else if (operationName === "oidc") {
            if (!options.auth.attachOidc || !options.auth.oidcEnabled) {
              throw failure(409, "RESOURCE_CONFLICT", "OIDC sign-in is not configured.");
            }
            const { subject } = request.body as { subject: string };
            await options.auth.attachOidc(userId, subject, actor, expectedVersion);
          } else if (operationName === "detach") {
            if (!options.auth.detachMethod) {
              throw dependencyUnavailable();
            }
            const { methodId } = request.params as { methodId: string };
            await options.auth.detachMethod(userId, methodId, actor, expectedVersion);
          } else {
            await options.auth.changeAccount(userId, operationName, actor, expectedVersion);
          }
          reply.send({ data: { userId }, meta: { requestId: request.id } });
        },
      );
    }

    const recoveryReadOperation = installationAuthOperation({
      operationId: "getAuthRecovery",
      method: "GET",
      path: "/api/auth/recovery",
      action: "openclaw.auth.recovery.read",
      summary: "Inspect the recovery account designation",
    });
    routes.get(
      recoveryReadOperation.path,
      {
        schema: authSchemas.readRecovery(recoveryReadOperation),
        onRequest: async (request) => admit(request, recoveryReadOperation),
        preValidation: async (request) => resolveIdentity(request, recoveryReadOperation),
      },
      async (request, reply) => {
        const context = contexts.get(request);
        if (!context) {
          throw dependencyUnavailable();
        }
        const actor = await humanAccountActor(request, recoveryReadOperation, context);
        if (!options.auth.readRecovery) {
          throw accountControlsUnsupported();
        }
        const recovery = await options.auth.readRecovery(actor);
        reply
          .header("cache-control", "no-store")
          .send({ data: recovery, meta: { requestId: request.id } });
      },
    );

    const recoveryReplaceOperation = installationAuthOperation({
      operationId: "replaceAuthRecovery",
      method: "POST",
      path: "/api/auth/recovery",
      action: "openclaw.auth.recovery.replace",
      summary: "Move the recovery designation to another Installation administrator",
    });
    routes.post(
      recoveryReplaceOperation.path,
      {
        schema: authSchemas.replaceRecovery(recoveryReplaceOperation),
        ...accountAdmission(recoveryReplaceOperation),
      },
      async (request, reply) => {
        const context = contexts.get(request);
        if (!context) {
          throw dependencyUnavailable();
        }
        const { userId, expectedCurrentUserId, expectedVersion } = request.body as {
          userId: string;
          expectedCurrentUserId: string;
          expectedVersion: number;
        };
        // Taking the designation acts against its holder, which then cannot be disabled, so the
        // actor must hold every grant of the holder's Principal. State commits only when the
        // expected holder is still current.
        const actor = await humanAccountActor(
          request,
          recoveryReplaceOperation,
          context,
          expectedCurrentUserId,
        );
        if (!options.auth.replaceRecovery) {
          throw accountControlsUnsupported();
        }
        // The new holder must administer the Installation, as startup requires of the seed. This
        // preflight gives an early refusal. State rechecks the exact locked successor's authority
        // under its policy fence before committing the replacement.
        let principal;
        let decision;
        const selected = selectedIAMDriver();
        try {
          principal = await selected.lookupIdentity({
            issuer: options.auth.issuer,
            subject: userId,
          });
          decision =
            principal?.kind === "principal"
              ? await selected.authorize({
                  principalId: principal.id,
                  action: "administer",
                  resource: { kind: "installation", id: installationId },
                })
              : undefined;
        } catch {
          throw dependencyUnavailable();
        }
        if (principal?.kind !== "principal") {
          throw failure(404, "NOT_FOUND", "The requested platform resource was not found.");
        }
        if (decision?.allowed !== true || decision.driverId !== selected.id) {
          throw failure(
            409,
            "RESOURCE_CONFLICT",
            "The recovery account must administer the Installation.",
          );
        }
        const recovery = await options.auth.replaceRecovery(
          userId,
          principal.id,
          expectedCurrentUserId,
          actor,
          expectedVersion,
        );
        reply.send({ data: recovery, meta: { requestId: request.id } });
      },
    );

    const enrolOperation = installationAuthOperation({
      operationId: "enrolAuthAccount",
      method: "POST",
      path: "/api/auth/accounts/:userId/enrol",
      action: "openclaw.auth.accounts.enrol",
      summary: "Enrol an existing account that activation skipped",
    });
    routes.post(
      enrolOperation.path,
      {
        schema: authSchemas.enrolAccount(enrolOperation),
        ...accountAdmission(enrolOperation),
      },
      async (request, reply) => {
        const context = contexts.get(request);
        if (!context) {
          throw dependencyUnavailable();
        }
        const actor = await humanAccountActor(request, enrolOperation, context);
        if (!options.auth.enrolAccount) {
          throw accountControlsUnsupported();
        }
        const { userId } = request.params as { userId: string };
        const enrolled = await options.auth.enrolAccount(userId, actor);
        reply.send({ data: { userId, ...enrolled }, meta: { requestId: request.id } });
      },
    );

    routes.post(
      "/api/auth/sign-in/email",
      {
        schema: {
          operationId: "signInEmail",
          summary: "Sign in with email and password",
          description:
            "Authenticates a local account and issues a user session cookie. In both profiles, repeated failed attempts for one email, or from one client address behind a trusted proxy, spend the password budget and may return 429 once it is spent. A successful sign-in also sets an HttpOnly known-device cookie; later attempts for that email from the same browser spend the browser's own budget instead of the email's. The cookie never authenticates. An email with a NUL character or an unpaired UTF-16 surrogate is refused with 400 INVALID_REQUEST and spends budget like a rejected password; the password is not checked for either.",
          tags: ["Authentication"],
          security: [],
          body: authSchemas.passwordBody,
          response: {
            // A browser Origin other than the console's, or a cross-site fetch, is refused
            // before the credentials are read.
            403: { description: "Forbidden", ...error },
            ...responses({
              type: "object",
              additionalProperties: false,
              required: ["authenticated"],
              properties: {
                authenticated: { type: "boolean", const: true },
                sessionKey: { type: "string" },
              },
            }),
            400: { description: "Bad Request", ...error },
            429: { description: "Too Many Requests", ...error },
            ...bodyErrors,
          },
        },
      },
      async (request, reply) => options.auth.signInEmail(request, reply),
    );
    routes.post(
      "/api/auth/sign-out",
      {
        schema: {
          operationId: "signOut",
          summary: "Sign out of the current session",
          description: "Revokes the current user session cookie.",
          tags: ["Authentication"],
          security: [{ sessionCookie: [] }],
          response: {
            ...responses({ type: "object", additionalProperties: true }),
            // A missing or foreign browser Origin, or a cross-site fetch.
            403: { description: "Forbidden", ...error },
          },
        },
      },
      async (request, reply) => options.auth.signOut(request, reply),
    );
    routes.get(
      "/api/auth/session",
      {
        schema: {
          operationId: "getAuthSession",
          summary: "Inspect authentication without revealing session tokens",
          description:
            "Returns authenticated status, public account identity, and a noncredential sessionKey that stays stable across reads and changes for a new session, or null without a valid session; session tokens and credentials are never returned.",
          tags: ["Authentication"],
          security: [],
          response: {
            200: {
              description: "OK",
              ...envelope({
                anyOf: [
                  { type: "null" },
                  {
                    type: "object",
                    additionalProperties: false,
                    required: ["authenticated", "sessionKey", "user"],
                    properties: {
                      authenticated: { type: "boolean", const: true },
                      sessionKey: { type: "string" },
                      user: {
                        type: "object",
                        additionalProperties: false,
                        required: ["id", "email", "name"],
                        properties: {
                          id: { type: "string" },
                          email: { type: "string", format: "email" },
                          name: { type: "string" },
                        },
                      },
                    },
                  },
                ],
              }),
            },
            503: { description: "Service Unavailable", ...error },
          },
        },
      },
      async (request, reply) => options.auth.session(request, reply),
    );
    routes.post<RouteGenericInterface, { rateLimit: RequestRateLimiter }>(
      createAuthAccountOperation.path,
      {
        config: { rateLimit: new RequestRateLimiter(10, 1 / 6) },
        schema: authSchemas.createAccount(createAuthAccountOperation),
        onRequest: async (request) => admit(request, createAuthAccountOperation),
        preValidation: async (request) => {
          // Passwords are hashed before persistence; their existing schema and hashing
          // rules remain authoritative. Validate every other submitted field unchanged.
          const body = request.body;
          refuseUnstorableText(
            request,
            typeof body === "object" && body !== null && !Array.isArray(body)
              ? { ...body, password: undefined }
              : body,
          );
          await resolveIdentity(request, createAuthAccountOperation);
        },
      },
      async (request, reply) => {
        const context = contexts.get(request);
        if (!context) {
          throw dependencyUnavailable();
        }
        if (options.provisionAuthAccount === undefined) {
          throw dependencyUnavailable();
        }

        const body = request.body as Record<string, unknown> | undefined;
        const email = body?.email;
        const password = body?.password;
        const name = body?.name;
        const roleId = body?.roleId;
        if (
          !isNonEmptyString(email) ||
          !isNonEmptyString(password) ||
          (roleId !== undefined && !isNonEmptyString(roleId)) ||
          (name !== undefined && !isNonEmptyString(name))
        ) {
          throw failure(
            400,
            "INVALID_REQUEST",
            "The request does not match the operation contract.",
          );
        }

        const { selected, target, decision } = await requireInstallationAdmin(
          request,
          createAuthAccountOperation,
          context,
        );

        // Charge the authorized Principal before hashing; new sessions and target
        // email addresses must not reset an administrator's account-creation budget.
        const retryAfter = request.routeOptions.config.rateLimit.consume(context.actorId);
        if (retryAfter !== undefined) {
          reply.header("retry-after", String(retryAfter));
          throw failure(
            429,
            "RATE_LIMITED",
            "Too many account creation requests. Wait before retrying.",
          );
        }

        const prepared = await options.auth.prepareAccount({
          email,
          password,
          ...(name === undefined ? {} : { name }),
        });
        // Each new account joins the configured `iam.defaultUserGroups` in its creating unit.
        const groupIds = controller?.defaultUserGroupIds ?? [];
        const seed = {
          ...options.auth.principalSeed(
            prepared,
            roleId === undefined ? { grant: "none" } : { roleId },
          ),
          ...(groupIds.length === 0 ? {} : { groupIds }),
        };
        const baseAuditEvent = event(
          createAuthAccountOperation,
          request,
          target,
          "mutation",
          context,
          decision.evidence,
        );
        // Record who was enrolled and what they were granted; never the email or password.
        const accountDetails = {
          principalId: seed.principal.id,
          ...(roleId === undefined ? { grant: "none" } : { roleId }),
          ...(groupIds.length === 0 ? {} : { groupIds }),
        };
        const auditEvent: AuditEvent = {
          ...baseAuditEvent,
          details: { ...baseAuditEvent.details, ...accountDetails },
        };
        try {
          const admitted = admissions.get(request);
          if (admitted === undefined) {
            throw dependencyUnavailable();
          }
          if (admitted.method !== "session") {
            throw failure(401, "UNAUTHENTICATED", "A human controller session is required.");
          }
          const session = admitted.session;
          const provision = () =>
            options.provisionAuthAccount!(seed, auditEvent, prepared, undefined, {
              holdSession: (unit: PlatformUnitOfWork) =>
                options.auth.holdSession(unit, session, request),
              authorize: async () => {
                // State calls this after its authority locks, on the account's original unit.
                // Let the HTTP error handler audit a denial after that unit rolls back.
                const current = await installationAdminDecision(selected, context.actorId, target);
                if (!current.allowed) {
                  throw new AuthorizationDeniedError(
                    current.reason,
                    current.evidence,
                    { action: "administer", resource: target },
                    context.actorId,
                  );
                }
                return event(
                  createAuthAccountOperation,
                  request,
                  target,
                  "mutation",
                  context,
                  current.evidence,
                  { outcome: "success", details: accountDetails },
                );
              },
            });
          await options.auth.withSessionAuthority(session, provision);
        } catch (error) {
          // The account, Principal and audit commit in one transaction, so nothing is
          // compensated here. Dependency errors keep their class: an unknown COMMIT
          // outcome must reach the caller as unknown, never as a plain outage.
          throw error instanceof RequestFailure ||
            error instanceof AuthorizationDeniedError ||
            error instanceof DependencyUnavailableError
            ? error
            : error instanceof UserAlreadyExistsError
              ? failure(409, "RESOURCE_CONFLICT", "The requested platform resource already exists.")
              : error instanceof AuthAccountRoleNotFoundError ||
                  error instanceof AuthAccountRoleInvalidError
                ? failure(
                    400,
                    "INVALID_REQUEST",
                    "The request does not match the operation contract.",
                  )
                : Object.assign(
                    new DependencyUnavailableError("Auth account provisioning failed."),
                    // The API log names the cause's class and code, never its message.
                    { cause: error },
                  );
        }
        const account = prepared;
        reply.status(201).send({
          data: {
            id: account.id,
            email: account.email,
            name: account.name,
            principalId: seed.principal.id,
          },
          meta: { requestId: request.id },
        });
      },
    );
  });

  void app.register(async (routes) => {
    routes.get<RouteGenericInterface, { rateLimit: RequestRateLimiter }>(
      nativeAdminReturnOperation.path,
      {
        schema: nativeAdminReturnSchema,
        // Bound session admission per direct peer. Proxies share this more generous budget;
        // the resolver separately limits expensive lookups by authenticated principal.
        config: { rateLimit: new RequestRateLimiter(60, 5) },
        onRequest: async (request, reply) => {
          limitNativeAdminReturn(request.routeOptions.config.rateLimit, request.ip, reply);
          await admit(request, nativeAdminReturnOperation);
        },
        preHandler: async (request) => resolveIdentity(request, nativeAdminReturnOperation),
      },
      nativeAdmin.resolveReturn,
    );
    routes.get<RouteGenericInterface, { rateLimit: RequestRateLimiter }>(
      CONNECTION_CALLBACK_PATH,
      {
        schema: connectionCallbackSchema,
        config: { rateLimit: new RequestRateLimiter(60, 5) },
        onRequest: async (request, reply) => {
          reply.header("referrer-policy", "no-referrer").header("cache-control", "no-store");
          const retryAfter = request.routeOptions.config.rateLimit.consume(request.ip);
          if (retryAfter !== undefined) {
            reply.header("retry-after", String(retryAfter));
            throw failure(
              429,
              "RATE_LIMITED",
              "Too many OAuth callback requests. Wait before retrying.",
            );
          }
          await admit(request, connectionCallbackOperation);
        },
        preHandler: async (request) => resolveIdentity(request, connectionCallbackOperation),
      },
      createConnectionCallback({
        withCurrentSession: (request, work) => {
          const admitted = admissions.get(request);
          if (admitted?.method !== "session") {
            throw failure(403, "FORBIDDEN", "A current browser session is required.");
          }
          return options.auth.withSessionAuthority(admitted.session, () =>
            work((unit) => options.auth.holdSession(unit, admitted.session, request)),
          );
        },
        getController: () => controller,
        getContext: (request) => contexts.get(request),
        auditEvent: (request, context, target) =>
          event(
            connectionCallbackOperation,
            request,
            target,
            "mutation",
            context,
            undefined,
            undefined,
            {
              action: "create",
              // OCC supplies the saved connection after consuming and authorizing its attempt.
              resource: {
                kind: "credential_source",
                id: target.namespaceId!,
                namespaceId: target.namespaceId!,
              },
            },
          ),
        auditFailure: (request, context, reasonCode) =>
          rejectedMutation(connectionCallbackOperation, request, context, reasonCode),
      }),
    );
    routes.route({
      method: "GET",
      url: nativeAdminStatusOperation.path,
      schema: nativeAdminStatusSchema,
      onRequest: async (request) => admit(request, nativeAdminStatusOperation),
      preHandler: async (request) => resolveIdentity(request, nativeAdminStatusOperation),
      handler: nativeAdmin.status,
    });
    for (const [operation, handler, confirm] of [
      [nativeAdminLaunchOperation, nativeAdmin.launch, false],
      [nativeAdminConfirmOperation, nativeAdmin.confirm, true],
    ] as const) {
      routes.route({
        method: "POST",
        url: operation.path,
        schema: nativeAdminLaunchSchema(confirm),
        onRequest: async (request, reply) => {
          reply.header("cache-control", "no-store");
          reply.header("referrer-policy", "no-referrer");
          await admit(request, operation);
        },
        preHandler: async (request) => resolveIdentity(request, operation),
        handler,
      });
    }
    for (const operation of occApiRoutes) {
      // Bootstrap has its own transactional evidence. Runtime log reads have their own
      // disclosure gate and can also return a download.
      const routeAuditSink =
        operation.operationId === "bootstrapInstallation" ||
        operation.operationId === "getAgentDeploymentRuntimeLogs"
          ? undefined
          : requestAuditSink;
      const { description, permissions } = routePermissionMetadata(operation);
      const schema: DocumentedFastifySchema = {
        ...operation.schema,
        operationId: operation.operationId,
        summary: operation.summary,
        description,
        tags: [...operation.tags],
        "x-openclaw-permissions": permissions,
        ...(operation.operationId === "bootstrapInstallation" ||
        operation.operationId === "listAgentAuditEvents"
          ? { security: [{ sessionCookie: [] }] }
          : {}),
      } as DocumentedFastifySchema;
      routes.route<RouteGenericInterface, { auditManagementRequest?: true }>({
        method: operation.method as HTTPMethods,
        url: operation.path,
        ...(routeAuditSink === undefined ? {} : { config: { auditManagementRequest: true } }),
        ...(operation.operationId === "chatWithAgent" ? { bodyLimit: AGENT_CHAT_BODY_LIMIT } : {}),
        ...(operation.operationId === "putAgentWorkspaceFile"
          ? { bodyLimit: WORKSPACE_FILE_BODY_LIMIT }
          : operation.operationId === "createAgent" ||
              operation.operationId === "validateAgentCreate" ||
              operation.operationId === "provisionAgent"
            ? { bodyLimit: options.maxBodyBytes ?? AGENT_CREATE_BODY_LIMIT }
            : operation.operationId === "createPreset" || operation.operationId === "updatePreset"
              ? { bodyLimit: options.maxBodyBytes ?? PRESET_BODY_LIMIT }
              : operation.operationId === "createConfiguration" ||
                  operation.operationId === "updateConfiguration"
                ? { bodyLimit: options.maxBodyBytes ?? CONFIGURATION_BODY_LIMIT }
                : {}),
        schema,
        onRequest: async (request) => {
          await admit(request, operation);
          if (authorizesBeforeBody(operation)) {
            await resolveIdentity(request, operation);
            await authorizeBeforeBody(request, operation);
          }
        },
        preValidation: async (request) => {
          const hasRequestBody =
            request.body !== undefined ||
            Number(request.headers["content-length"] ?? 0) > 0 ||
            request.headers["transfer-encoding"] !== undefined;
          if (operation.operationId === "deployAgent" && !hasRequestBody) {
            request.body = {};
          }
          if (!Object.hasOwn(operation.schema, "body") && hasRequestBody) {
            throw failure(
              400,
              "INVALID_REQUEST",
              "The request does not match the operation contract: this operation accepts no request body.",
            );
          }
          const unstorable =
            unstorableTextFailure("params", request.params) ??
            (operation.operationId === "chatWithAgent"
              ? undefined
              : unstorableTextFailure("body", request.body));
          if (unstorable !== undefined) {
            throw unstorable;
          }
        },
        ...(authorizesBeforeBody(operation)
          ? {}
          : { preHandler: async (request: FastifyRequest) => resolveIdentity(request, operation) }),
        handler: async (request, reply) => {
          if (routeAuditSink === undefined) {
            return performFenced(request, reply, operation);
          }
          // Admission here means the request can enter the handler. The handler still
          // checks the caller's permission for the exact operation and target.
          if (
            controller !== undefined &&
            requestAuditState.has(request) &&
            !(await appendRequestAudit(routeAuditSink, request, operation, {
              action: API_REQUEST_AUDIT_ACTIONS.admitted,
              outcome: "success",
            }))
          ) {
            throw dependencyUnavailable();
          }
          if (controller === undefined) {
            await performFenced(request, reply, operation);
          } else {
            await controller.withRequestAuditId(request.id, () =>
              performFenced(request, reply, operation),
            );
          }
          // Wait for an asynchronous onSend hook when perform called reply.send().
          return reply;
        },
        ...(routeAuditSink === undefined
          ? {}
          : {
              onSend: async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
                const audit = requestAuditState.get(request);
                if (audit === undefined || audit.resultSelected || controller === undefined) {
                  return payload;
                }
                // A later transport or reply error can re-enter onSend. Record the first selected
                // response once, including when its append fails.
                audit.resultSelected = true;
                const statusCode = reply.statusCode;
                let outcome: "success" | "denied" | "failure" = "success";
                if (
                  statusCode < 500 &&
                  (audit.denialObserved || statusCode === 401 || statusCode === 403)
                ) {
                  outcome = "denied";
                } else if (statusCode >= 400) {
                  outcome = "failure";
                }
                const readTarget =
                  outcome === "success" && statusCode === 200 ? audit.readTarget : undefined;
                // Preserve the selected response if the append fails. The handler may have
                // committed its change or already denied the request.
                await appendRequestAudit(routeAuditSink, request, operation, {
                  action: API_REQUEST_AUDIT_ACTIONS.result,
                  outcome,
                  statusCode,
                  ...(readTarget === undefined ? {} : { readTarget }),
                  ...(audit.commitOutcomeUnknown === true
                    ? { reasonCode: "COMMIT_OUTCOME_UNKNOWN" }
                    : {}),
                });
                return payload;
              },
            }),
      });
    }
  });

  app.route({
    method: ["GET", "HEAD"],
    url: "/console",
    handler: async (request, reply) => serveConsole(request, reply),
  });
  app.route({
    method: ["GET", "HEAD"],
    url: "/console/*",
    handler: async (request, reply) => serveConsole(request, reply),
  });

  async function serveConsole(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const pathname = request.url.split("?", 1)[0] ?? "";
    const asset = await readConsoleAsset(
      pathname,
      request.headers["accept-encoding"],
      options.consoleTheme,
    );
    if (asset.contentType.startsWith("text/html") || pathname.startsWith("/console/theme/")) {
      reply.header("cache-control", "no-store");
    }
    const nativeFormOrigin =
      options.nativeAdmin?.enabled &&
      options.nativeAdmin.sessionMode === "host-only-exchange" &&
      publicOrigin
        ? ` https://*.${normalizeNativeAdminDomain(options.nativeAdmin.domain)}${new URL(publicOrigin).port ? `:${new URL(publicOrigin).port}` : ""}`
        : "";
    reply.header(
      "content-security-policy",
      CONSOLE_CONTENT_SECURITY_POLICY.replace(
        "form-action 'self'",
        `form-action 'self'${nativeFormOrigin}`,
      ),
    );
    reply.header("content-type", asset.contentType);
    reply.header("content-length", asset.body.length);
    if (asset.variesByEncoding) {
      reply.header("vary", "Accept-Encoding");
    }
    if (asset.contentEncoding !== undefined) {
      reply.header("content-encoding", asset.contentEncoding);
    }
    reply.status(asset.statusCode).send(request.method === "HEAD" ? undefined : asset.body);
  }

  // Route patterns are fixed for this app; retain contract order for the Allow header.
  const methodRoutes = occApiRoutes.map(({ method, path }) => ({
    method,
    pattern: new RegExp(`^${path.replace(/:[^/]+/g, "[^/]+")}$`),
  }));
  app.setNotFoundHandler(async (request, reply) => {
    const pathname = request.url.split("?", 1)[0] ?? "";
    const allowed = methodRoutes
      .filter(({ pattern }) => pattern.test(pathname))
      .map(({ method }) => method);
    if (allowed.length > 0) {
      reply.header("allow", [...new Set(allowed)].join(", "));
      canonicalFailure(
        reply,
        failure(405, "METHOD_NOT_ALLOWED", "The requested HTTP method is not supported."),
      );
      return;
    }
    // No route has this path's shape, so the answer says that rather than "resource not found"
    // (finding D764). It reads only the path, never stored state, so it is the same for every ID.
    const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
    canonicalFailure(
      reply,
      failure(
        404,
        "NOT_FOUND",
        trimmed !== pathname && methodRoutes.some(({ pattern }) => pattern.test(trimmed))
          ? "No API route has this path: remove the trailing slash."
          : "No API route has this path. Check it against the API reference.",
      ),
    );
  });

  /**
   * Which IDs a caller's own denial may name: those the request carried and, for a resource read
   * from stored state, such as a Secret an Agent or Configuration binds, that resource when the
   * caller may already read it (finding 2594) and may read every record the route's path names,
   * such as that Agent or Configuration: the binding is part of that record (finding 2614). Only the
   * caller's own denial of an action other than read or create asks; an IAM failure while asking
   * only hides the ID.
   */
  async function nameableIds(
    error: unknown,
    actorId: string | undefined,
    sent: (value: string) => boolean,
    owners: readonly ResourceRef[],
  ): Promise<(value: string) => boolean> {
    if (
      actorId === undefined ||
      !isAuthorizationDenied(error) ||
      isDependencyUnavailable(error) ||
      error instanceof AgentPrincipalAuthorizationError ||
      error.authorization === undefined ||
      error.checkedPrincipalId !== actorId
    ) {
      return sent;
    }
    const { action, resource } = error.authorization;
    if (
      action === "read" ||
      action === "create" ||
      resource.kind === "installation" ||
      sent(resource.id)
    ) {
      return sent;
    }
    for (const reference of [...owners, resource]) {
      if (!(await callerMay(actorId, "read", reference).catch(() => false))) {
        return sent;
      }
    }
    return (value) => value === resource.id || sent(value);
  }

  /**
   * The records a route's path names that bind other resources, for `nameableIds`: an Agent, a
   * Configuration (its Secret bindings) or a credential source (its Secrets).
   */
  function routeOwners(request: FastifyRequest): ResourceRef[] {
    const params = request.params as Record<string, unknown> | undefined;
    const namespaceId = params?.namespaceId;
    if (typeof namespaceId !== "string") {
      return [];
    }
    return (
      [
        ["agentId", "agent"],
        ["configurationId", "configuration"],
        ["credentialSourceId", "credential_source"],
      ] as const
    ).flatMap(([param, kind]) => {
      const id = params?.[param];
      return typeof id === "string" ? [{ kind, id, namespaceId }] : [];
    });
  }

  /**
   * Whether `error` is the caller's own create denial, by a Restriction, while the caller
   * administers the Installation: only then does the text name the Restriction (finding D769).
   * Administration is the non-auditing check the Namespace permission answer makes; a failed
   * check keeps the plain text.
   */
  async function administratorRestricted(error: unknown, actorId: string | undefined) {
    if (
      actorId === undefined ||
      !isAuthorizationDenied(error) ||
      isDependencyUnavailable(error) ||
      error.checkedPrincipalId !== actorId ||
      error.authorization?.action !== "create" ||
      error.authorization.resource.kind === "namespace" ||
      (error.evidence?.restrictionIds.length ?? 0) === 0
    ) {
      return false;
    }
    return callerMay(actorId, "administer", { kind: "installation", id: installationId }).catch(
      () => false,
    );
  }

  app.setErrorHandler(async (error, request, reply) => {
    // A caller's own denial names a resource ID only when this request carried it or the caller
    // may already read that resource.
    const actorId = contexts.get(request)?.actorId;
    let mapped = requestFailure(error, {
      requested: await nameableIds(error, actorId, requestedValues(request), routeOwners(request)),
      ...(actorId === undefined ? {} : { actorId }),
      ...((await administratorRestricted(error, actorId)) ? { administratorRestricted: true } : {}),
    });
    if (error instanceof RuntimeLogsError && error.retryAfterSeconds !== undefined) {
      reply.header("retry-after", String(error.retryAfterSeconds));
    }
    if (error instanceof DeviceAuthorizationScopeMismatchError) {
      const context = contexts.get(request);
      if (
        context &&
        (context.operation.operationId === "pollAgentDeviceAuthorization" ||
          context.operation.operationId === "pollSavedAgentDeviceAuthorization" ||
          context.operation.operationId === "cancelAgentDeviceAuthorization" ||
          context.operation.operationId === "cancelSavedAgentDeviceAuthorization")
      ) {
        try {
          await denial(
            context.operation,
            request,
            "authorization_denial",
            context,
            undefined,
            undefined,
            {
              decisionReason: "The device login does not belong to the requested scope.",
              reasonCode: "DEVICE_AUTHORIZATION_SCOPE_MISMATCH",
              details: {},
              requireAuditWrite: true,
            },
          );
        } catch (auditError) {
          mapped = requestFailure(auditError);
        }
      }
    }
    if (isAuthorizationDenied(error) && !isDependencyUnavailable(error)) {
      const context = contexts.get(request);
      if (context) {
        try {
          if (error instanceof AgentPrincipalAuthorizationError) {
            // The caller's own grants passed; the Agent's service principal was denied. Record
            // the caller's request and name that principal, its grant and its evidence, so the
            // event never reads as the caller lacking the grant.
            await denial(
              context.operation,
              request,
              "authorization_denial",
              context,
              undefined,
              undefined,
              {
                decisionReason: error.message,
                reasonCode: "AGENT_PRINCIPAL_NOT_AUTHORIZED",
                details: {
                  servicePrincipalId: error.principalId,
                  action: error.authorization.action,
                  resource: error.authorization.resource,
                  ...(error.evidence === undefined
                    ? {}
                    : { servicePrincipalEvidence: error.evidence }),
                },
              },
            );
          } else {
            let explanation: Parameters<typeof denial>[6];
            if (error instanceof DeletionRetryOwnedError) {
              explanation = {
                decisionReason:
                  "A deletion can be retried only by its initiating actor while it holds delete.",
                details: { initiatingActorId: error.initiatingActorId },
              };
            }
            if (error instanceof AccountPrincipalAccessDeniedError) {
              explanation = {
                decisionReason: error.message,
                reasonCode: "ACCOUNT_PRINCIPAL_GRANTS_NOT_COVERED",
                details: { userId: error.userId, principalId: error.principalId },
              };
            }
            await denial(
              context.operation,
              request,
              "authorization_denial",
              context,
              error.evidence,
              error.authorization,
              explanation,
            );
          }
        } catch (auditError) {
          mapped = requestFailure(auditError);
        }
      }
    }
    if (error instanceof RuntimeCredentialsForbiddenByClusterError) {
      // The response names the RoleBinding; the log names the exact denied call.
      app.log.warn({
        event: "agent_runtime_credentials.cluster_denied",
        requestId: request.id,
        route: request.routeOptions.url ?? "unmatched",
        verb: error.verb,
        resource: error.resource,
        kubernetesNamespace: error.kubernetesNamespace,
        plane: error.plane,
        kubernetesStatus: error.status,
      });
    }
    if (error instanceof ComputeProvisioningRefusedError) {
      // The response keeps fixed text, because the Compute Driver's reason can name
      // Installation gateway or routing settings; the operator finds it here by request ID.
      app.log.warn({
        event: "agent_provisioning.compute_refused",
        requestId: request.id,
        route: request.routeOptions.url ?? "unmatched",
        reason: error.reason,
      });
    }
    if (error instanceof DeviceAuthorizationStartError) {
      app.log.warn({
        event: "device_authorization.start_failed",
        requestId: request.id,
        route: request.routeOptions.url ?? "unmatched",
        boundary: "credential_refresh",
        reason: error.reason,
        failure: error.failure,
      });
    }
    if (
      mapped.status === 503 &&
      mapped.code === "DEPENDENCY_UNAVAILABLE" &&
      error instanceof Error &&
      isDependencyUnavailable(error)
    ) {
      // The response keeps its text (the caller learns nothing more); the operator finds the
      // cause here by request ID. Reading the error must never change the response.
      let fields: ReturnType<typeof dependencyUnavailableLogFields> = {};
      try {
        fields = dependencyUnavailableLogFields(error);
      } catch {
        // An error whose fields cannot be read is logged without them.
      }
      app.log.warn({
        event: "http.dependency_unavailable",
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url ?? "unmatched",
        ...fields,
      });
    }
    if (mapped.code === "INTERNAL_ERROR") {
      app.log.error({
        event: "http.unexpected_error",
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url ?? "unmatched",
        status: mapped.status,
        code: mapped.code,
      });
    }
    const operation = contexts.get(request)?.operation;
    const audit = requestAuditState.get(request);
    if (audit !== undefined && operation !== undefined) {
      if (error instanceof AuditAppendUnavailableError) {
        logRequestAuditFailure(request, operation, auditAction(operation, request), error);
      } else if (error instanceof PostgresCommitOutcomeUnknownError) {
        audit.commitOutcomeUnknown = true;
        app.log.error({
          event: "http.commit_outcome_unknown",
          requestId: request.id,
          operationId: operation.operationId,
          code: "COMMIT_OUTCOME_UNKNOWN",
        });
      }
    }
    canonicalFailure(reply, mapped);
    return reply;
  });

  return app;
}

export function createControllerApp(options: ControllerAppOptions): ControllerApp {
  const app = createFastifyApp(options);
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const headers: Record<string, string> = {};
      request.headers.forEach((value, name) => {
        headers[name] = value;
      });
      headers.host = url.host;
      const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
      const result = await app.inject({
        method: request.method as NonNullable<InjectOptions["method"]>,
        url: `${url.pathname}${url.search}`,
        headers,
        ...(body === undefined ? {} : { payload: body }),
        remoteAddress: "127.0.0.1",
      });
      const convertedHeaders = new Headers();
      for (const [name, value] of Object.entries(result.headers)) {
        if (Array.isArray(value)) {
          for (const entry of value) {
            convertedHeaders.append(name, entry);
          }
        } else if (value !== undefined) {
          convertedHeaders.set(name, String(value));
        }
      }
      return new Response(result.statusCode === 204 ? null : new Uint8Array(result.rawPayload), {
        status: result.statusCode,
        headers: convertedHeaders,
      });
    },
  };
}

import swagger from "@fastify/swagger";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { AuditEventFactory, type AuditSink } from "@openclaw-enterprise/audit";
import {
  AgentDeploymentDiagnosticsResponse,
  AgentRuntimeCredentialResponse,
  AgentRuntimeLogsResponse,
  AgentRuntimeResponse,
  CredentialSourceResponse,
  ErrorDetail as ErrorDetailSchema,
  ErrorResponse,
  JsonValue,
  occApiRoutes,
  PluginApproversSchema,
  PluginDesiredSelectionSchema,
  PluginDesiredStateSchema,
  PluginDriverIdentitySchema,
  PluginToolDefaultsSchema,
  PluginToolPolicySchema,
  SecretResponse,
  type AgentRuntimeLogsQuery,
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
  type PermissionAction,
  type ResourceKind,
  type ResourceRef,
  type SandboxDriver,
  type SecretDriver,
  type SecretReference,
  type UpdateWorkspaceFileBody,
  type WorkspaceFileName,
} from "@openclaw-enterprise/contracts";
import {
  AuthAccountRoleInvalidError,
  AuthAccountRoleNotFoundError,
  NativeIAMDriver,
  type AuthPrincipalSeed,
} from "@openclaw-enterprise/iam";
import {
  AgentPrincipalAuthorizationError,
  AuthorizationDeniedError,
  DeletionRetryOwnedError,
  BOOTSTRAP_DEFAULT_NAMESPACE_NAME,
  ComputeProvisioningRefusedError,
  createRuntimeLogCursorCodec,
  DependencyUnavailableError,
  DeviceAuthorizationStartError,
  ResourceConflictError,
  RuntimeCredentialsForbiddenByClusterError,
  RuntimeLogsError,
  UserAlreadyExistsError,
  type DeployAgentAuthorization,
  type HarnessResolver,
  type OpenClawController,
} from "@openclaw-enterprise/occ";
import { isNonEmptyString } from "@openclaw-enterprise/utils";
import SerializerSelector from "@fastify/fast-json-stringify-compiler";
import ajvFormats from "ajv-formats";
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifySchema,
  type HTTPMethods,
  type InjectOptions,
} from "fastify";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdmittedCaller } from "./admission/admission-verifier.ts";
import {
  OCC_SERVICE_KEY_HEADER,
  type ClientAddressConfiguration,
  type ControllerAuth,
  type PreparedAuthAccount,
} from "./auth/index.ts";
import { CONSOLE_CONTENT_SECURITY_POLICY, readConsoleAsset } from "./console-assets.ts";
import {
  ControllerWorkspaceFileUnknownOutcomeError,
  isAllowedWorkspaceFileName,
  type ControllerWorkspaceFileReadResult,
  type ControllerWorkspaceFilesAccess,
  type ControllerWorkspaceFileWriteResult,
} from "./gateway/contracts.ts";
import type { NativeAdminAccessConfig } from "./gateway/native-admin.ts";
import { createAgentHandlers } from "./http/agents.ts";
import { configurationHandlers } from "./http/configurations.ts";
import { credentialSourceHandlers } from "./http/credential-sources.ts";
import {
  canonicalFailure,
  cappedPath,
  dependencyUnavailable,
  failure,
  isAuthorizationDenied,
  isDependencyUnavailable,
  jsonPointer,
  RequestFailure,
  requestFailure,
  responseHeaders,
  unstorableTextFailure,
  type ErrorDetail,
} from "./http/errors.ts";
import { iamHandlers } from "./http/iam.ts";
import {
  createNativeAdminAccess,
  nativeAdminStatusOperation,
  nativeAdminStatusSchema,
} from "./http/native-admin.ts";
import { presetHandlers } from "./http/presets.ts";
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
import { secretHandlers } from "./http/secrets.ts";
import { serviceAccountHandlers } from "./http/service-accounts.ts";
import type { RequestContext, ResourceHandlers } from "./http/types.ts";

export interface DevelopmentAdmission {
  readonly enabled: boolean;
  readonly installationId?: string;
  readonly trustedCidrs?: readonly string[];
}

export interface ControllerAppOptions {
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
  readonly backendSummaries?: readonly BackendSummary[];
  readonly observabilityUrl?: string;
  readonly development: DevelopmentAdmission;
  readonly maxBodyBytes?: number;
  readonly auth: ControllerAuth;
  readonly workspaceFilesAccess?: ControllerWorkspaceFilesAccess;
  readonly workspaceFileRequestTimeoutMs?: number;
  readonly nativeAdmin?: NativeAdminAccessConfig;
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
  readonly provisionAuthAccount?: (
    seed: AuthPrincipalSeed,
    auditEvent: AuditEvent,
    prepared: PreparedAuthAccount,
    external?: { readonly providerId: string; readonly subject: string },
  ) => Promise<void>;
  readonly auditEventFactory?: AuditEventFactory;
  readonly logger?: FastifyBaseLogger;
  /** Production proxies allowed to send forwarded headers; admission ignores those headers. */
  readonly trustedProxies?: Pick<ClientAddressConfiguration, "trusts">;
}

export interface ControllerApp {
  fetch(request: Request): Promise<Response>;
}

interface RequiredPermission {
  readonly action: PermissionAction;
  readonly resourceKind: ResourceKind;
  readonly scope: "requested" | "installation" | "namespace" | "each_returned" | "request_body";
  readonly condition?:
    | "associated_service_account"
    | "existing_namespace"
    | "bound_secret"
    | "directory_lookup"
    | "selected_secret"
    | "iam_binding_target"
    | "provisioning_work"
    | "missing_runtime_credentials"
    | "authenticated_plugin_discovery"
    | "read_logs_alternative";
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
const WORKSPACE_FILE_BODY_LIMIT = 48 * 1024;
const WORKSPACE_FILE_CONTENT_LIMIT = 16 * 1024;
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

function formatsPlugin(ajv: Parameters<typeof ajvFormats.default>[0]) {
  return ajvFormats.default(ajv);
}

// Fastify compiles one response serializer per route and status code, and rebuilds its
// serializer factory for every route in a plugin that added shared schemas; each
// fast-json-stringify build then re-validates every shared schema. That was about 1,100
// builds (830 of them the same ErrorResponse reference) and most of the API's boot at the
// chart's 500m CPU limit. A serializer depends only on its schema, the shared schemas and
// the serializer options, so build each distinct combination once.
function cachedResponseSerializers(): SerializerSelector.SerializerFactory {
  const buildSerializerCompiler = SerializerSelector();
  const sharedSchemaIds = new WeakMap<object, number>();
  // Never pruned. That is safe only while every serializer is built at route registration,
  // a fixed set. Compiling per request (reply.compileSerializationSchema or serializeInput
  // with a schema assembled at request time) would grow this Map without bound; such a
  // route must set its own serializerCompiler.
  const serializers = new Map<string, SerializerSelector.Serializer>();
  let nextSharedSchemaId = 0;
  const sharedSchemaId = (schema: object) => {
    let id = sharedSchemaIds.get(schema);
    if (id === undefined) {
      id = nextSharedSchemaId++;
      sharedSchemaIds.set(schema, id);
    }
    return id;
  };
  return (externalSchemas, options) => {
    const compile = buildSerializerCompiler(externalSchemas, options);
    const sharedSchemas = Object.entries((externalSchemas ?? {}) as Record<string, unknown>);
    // Shared schemas are keyed by object identity in a WeakMap; a context with any shared
    // schema that is not a plain object compiles uncached instead.
    if (sharedSchemas.some(([, schema]) => typeof schema !== "object" || schema === null)) {
      return compile;
    }
    // Fastify passes the same stored schema objects each time; identity names the set.
    const shared = sharedSchemas
      .map(([id, schema]) => `${id}=${sharedSchemaId(schema as object)}`)
      .join(",");
    const prefix = `${JSON.stringify(options ?? {})}|${shared}|`;
    // Route schemas are fixed at registration. A schema JSON cannot express (a cycle or a
    // BigInt keyword) compiles uncached rather than failing registration here.
    return (route) => {
      let key: string;
      try {
        key = prefix + JSON.stringify(route.schema);
      } catch {
        return compile(route);
      }
      let serializer = serializers.get(key);
      if (serializer === undefined) {
        serializer = compile(route);
        serializers.set(key, serializer);
      }
      return serializer;
    };
  };
}

function ipv4(value: string): number | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
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
  if (!/^\d+$/.test(prefixText) || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
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
  if (depth > 24) {
    throw failure(400, "INVALID_REQUEST", "The supplied configuration is invalid.", [
      { path: cappedPath(path), code: "TOO_DEEP" },
    ]);
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

function operationTarget(
  operation: OccApiRoute,
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
      operation.operationId === "listCredentialSources") &&
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

function requiredPermissions(operation: OccApiRoute): readonly RequiredPermission[] {
  const permission = {
    action: operation.iamAction,
    resourceKind: operation.resourceKind,
  };

  if (operation.operationId.endsWith("DeviceAuthorization")) {
    const saved = operation.operationId.includes("SavedAgent");
    return [
      {
        action: saved ? "update" : "create",
        resourceKind: "agent",
        scope: saved ? "requested" : "namespace",
      },
      ...(saved
        ? [{ action: "read" as const, resourceKind: "agent" as const, scope: "requested" as const }]
        : []),
      {
        action: operation.operationId.startsWith("start") ? "create" : "operate",
        resourceKind: "secret",
        scope: operation.operationId.startsWith("start") ? "namespace" : "requested",
      },
    ];
  }

  if (operation.operationId === "createNamespace") {
    return [
      { ...permission, scope: "installation" },
      {
        action: "administer",
        resourceKind: "installation",
        scope: "requested",
        condition: "existing_namespace",
      },
    ];
  }

  if (
    operation.operationId === "createConfiguration" ||
    operation.operationId === "updateConfiguration"
  ) {
    return [
      {
        ...permission,
        scope: operation.operationId === "createConfiguration" ? "namespace" : "requested",
      },
      {
        action: "operate",
        resourceKind: "secret",
        scope: operation.operationId === "createConfiguration" ? "request_body" : "requested",
        condition: "bound_secret",
      },
    ];
  }

  if (
    operation.operationId === "discoverAgentPlugins" ||
    operation.operationId === "discoverAgentPluginDetails"
  ) {
    return [
      { ...permission, scope: "namespace" },
      {
        action: "operate",
        resourceKind: "secret",
        scope: "request_body",
        condition: "selected_secret",
      },
    ];
  }

  if (operation.operationId === "createSecret") {
    return [{ ...permission, scope: "namespace" }];
  }

  if (operation.operationId === "lookupChannelDirectory") {
    return [
      {
        action: "operate",
        resourceKind: "secret",
        scope: "request_body",
        condition: "directory_lookup",
      },
      {
        action: "create",
        resourceKind: "agent",
        scope: "namespace",
        condition: "directory_lookup",
      },
      {
        action: "update",
        resourceKind: "agent",
        scope: "request_body",
        condition: "directory_lookup",
      },
      {
        action: "update",
        resourceKind: "configuration",
        scope: "request_body",
        condition: "directory_lookup",
      },
    ];
  }

  if (operation.operationId === "createIAMAccessBinding") {
    return [
      { action: "administer", resourceKind: "installation", scope: "requested" },
      { action: "read", resourceKind: "namespace", scope: "requested" },
      {
        action: "read",
        resourceKind: "agent",
        scope: "request_body",
        condition: "iam_binding_target",
      },
      {
        action: "read",
        resourceKind: "agent_revision",
        scope: "request_body",
        condition: "iam_binding_target",
      },
      {
        action: "read",
        resourceKind: "configuration",
        scope: "request_body",
        condition: "iam_binding_target",
      },
      {
        action: "read",
        resourceKind: "credential_source",
        scope: "request_body",
        condition: "iam_binding_target",
      },
      {
        action: "read",
        resourceKind: "namespace",
        scope: "request_body",
        condition: "iam_binding_target",
      },
      {
        action: "read",
        resourceKind: "preset",
        scope: "request_body",
        condition: "iam_binding_target",
      },
      {
        action: "read",
        resourceKind: "secret",
        scope: "request_body",
        condition: "iam_binding_target",
      },
      {
        action: "read",
        resourceKind: "service_account",
        scope: "request_body",
        condition: "iam_binding_target",
      },
    ];
  }

  if (
    operation.operationId === "listIAMRoles" ||
    operation.operationId === "createIAMRole" ||
    operation.operationId === "getIAMRole" ||
    operation.operationId === "deleteIAMRole" ||
    operation.operationId === "listIAMAccessBindings" ||
    operation.operationId === "getIAMAccessBinding" ||
    operation.operationId === "deleteIAMAccessBinding"
  ) {
    return [
      { action: "administer", resourceKind: "installation", scope: "requested" },
      { action: "read", resourceKind: "namespace", scope: "requested" },
    ];
  }

  if (
    operation.operationId === "provisionAgent" ||
    operation.operationId === "createAgent" ||
    operation.operationId === "updateAgent" ||
    operation.operationId === "deployAgent"
  ) {
    return [
      {
        ...permission,
        scope:
          operation.operationId === "createAgent" || operation.operationId === "provisionAgent"
            ? "namespace"
            : "requested",
      },
      ...(operation.operationId === "provisionAgent"
        ? [
            {
              action: "create" as const,
              resourceKind: "configuration" as const,
              scope: "namespace" as const,
            },
            {
              action: "administer" as const,
              resourceKind: "installation" as const,
              scope: "requested" as const,
            },
          ]
        : [
            {
              action: "read" as const,
              resourceKind: "configuration" as const,
              scope: "requested" as const,
            },
          ]),
      ...(operation.operationId === "deployAgent"
        ? [
            {
              action: "read" as const,
              resourceKind: "agent" as const,
              scope: "requested" as const,
              condition: "missing_runtime_credentials" as const,
            },
            {
              action: "operate" as const,
              resourceKind: "agent" as const,
              scope: "requested" as const,
              condition: "missing_runtime_credentials" as const,
            },
          ]
        : []),
      {
        action: "read",
        resourceKind: "service_account",
        scope: "requested",
        condition: "associated_service_account",
      },
      {
        action: "operate",
        resourceKind: "secret",
        scope: "requested",
        condition: "bound_secret",
      },
    ];
  }

  if (
    operation.operationId === "getAgentProvisioning" ||
    operation.operationId === "retryAgentProvisioning"
  ) {
    // Mirrors OCC authorizeProvisioningRequest, then authorizeProvisioningRecord.
    return [
      { action: "create", resourceKind: "agent", scope: "namespace" },
      { action: "create", resourceKind: "configuration", scope: "namespace" },
      { action: "administer", resourceKind: "installation", scope: "requested" },
      ...(["read", "operate", "deploy"] as const).map((action) => ({
        action,
        resourceKind: "agent" as const,
        scope: "requested" as const,
        condition: "provisioning_work" as const,
      })),
      ...(["read", "update"] as const).map((action) => ({
        action,
        resourceKind: "configuration" as const,
        scope: "requested" as const,
        condition: "provisioning_work" as const,
      })),
      {
        action: "read",
        resourceKind: "service_account",
        scope: "requested",
        condition: "associated_service_account",
      },
      {
        action: "operate",
        resourceKind: "secret",
        scope: "requested",
        condition: "bound_secret",
      },
    ];
  }

  if (operation.operationId === "provisionAgentRuntimeCredentials") {
    return [
      { ...permission, scope: "requested" },
      { action: "read", resourceKind: "agent", scope: "requested" },
    ];
  }

  if (
    operation.operationId === "getSavedAgentPluginPolicyCapabilities" ||
    operation.operationId === "discoverSavedAgentPlugins" ||
    operation.operationId === "discoverSavedAgentPluginDetails"
  ) {
    return [
      { ...permission, scope: "requested" },
      { action: "read", resourceKind: "agent", scope: "requested" },
      ...(operation.operationId === "getSavedAgentPluginPolicyCapabilities"
        ? []
        : [
            {
              action: "operate" as const,
              resourceKind: "secret" as const,
              scope: "requested" as const,
              condition: "authenticated_plugin_discovery" as const,
            },
          ]),
    ];
  }

  if (operation.operationId === "diagnoseAgentDeployment") {
    return [
      { action: "operate", resourceKind: "agent", scope: "requested" },
      { action: "read", resourceKind: "agent", scope: "requested" },
      { action: "read", resourceKind: "agent_revision", scope: "requested" },
    ];
  }

  if (operation.operationId === "getAgentDeploymentRuntime") {
    return [
      { action: "operate", resourceKind: "agent", scope: "requested" },
      { action: "read", resourceKind: "agent", scope: "requested" },
      { action: "read", resourceKind: "agent_revision", scope: "requested" },
    ];
  }

  if (operation.operationId === "getAgentDeploymentRuntimeLogs") {
    return [
      { action: "read_logs", resourceKind: "agent", scope: "requested" },
      {
        action: "administer",
        resourceKind: "agent",
        scope: "requested",
        condition: "read_logs_alternative",
      },
      { action: "read", resourceKind: "agent", scope: "requested" },
    ];
  }

  switch (operation.authorizationTarget) {
    case "namespace_collection":
      return [{ ...permission, scope: "namespace" }];
    case "namespace_candidates":
      return [{ ...permission, scope: "each_returned" }];
    case "namespace_and_agent_candidates":
      return [
        { action: "read", resourceKind: "namespace", scope: "requested" },
        { ...permission, scope: "each_returned" },
      ];
    case "namespace_and_service_account_candidates":
    case "namespace_and_secret_candidates":
    case "namespace_and_preset_candidates":
    case "namespace_and_credential_source_candidates":
      return [
        { action: "read", resourceKind: "namespace", scope: "requested" },
        { ...permission, scope: "each_returned" },
      ];
    case "agent_collection":
      return [
        { ...permission, scope: "requested" },
        { action: "read", resourceKind: "agent_revision", scope: "each_returned" },
      ];
    default:
      return [{ ...permission, scope: "requested" }];
  }
}

function permissionDescription(
  permissions: readonly RequiredPermission[],
  operation?: OccApiRoute,
): string {
  if (
    operation?.operationId === "getAgentProvisioning" ||
    operation?.operationId === "retryAgentProvisioning"
  ) {
    const verb = operation.operationId === "getAgentProvisioning" ? "read" : "retry";
    // The provisioning_work rows are described here, not per row.
    return `Requires create permission for Agent and Configuration resources in the requested Namespace and administer permission on the Installation. These are checked from the request path before any lookup, so a caller without them gets 403 whether or not the Namespace or work item exists. Only the principal that started the work can ${verb} it. The caller also needs read, operate and deploy permission on the work's Agent and read and update permission on its Configuration once the work has created them, operate permission on each Secret the work binds or uses for Harness authentication, and read permission on its Harness ServiceAccount when present. OCC re-checks these grants against the initiator while the work runs.`;
  }
  const names: Record<ResourceKind, string> = {
    installation: "Installation",
    namespace: "Namespace",
    configuration: "Configuration",
    preset: "Preset",
    service_account: "ServiceAccount",
    secret: "Secret",
    agent: "Agent",
    agent_revision: "AgentRevision",
    credential_source: "CredentialSource",
  };

  const description = permissions
    .map(({ action, resourceKind, scope, condition }) => {
      const name = names[resourceKind];
      if (condition === "associated_service_account") {
        return `Requires ${action} permission on each currently associated or newly associated ${name} when present.`;
      }
      if (condition === "directory_lookup") {
        if (resourceKind === "secret") {
          return "Requires operate permission on the exact Secret named by secretId.";
        }
        if (action === "create") {
          return "Without an edit target, requires Agent create permission in the Namespace.";
        }
        return `With ${resourceKind === "agent" ? "agentId" : "configurationId"}, requires update permission on that exact ${name}.`;
      }
      if (condition === "existing_namespace") {
        return `Requires ${action} permission on the ${name} when selecting an existing Kubernetes namespace.`;
      }
      if (condition === "selected_secret") {
        return `Requires ${action} permission on the exact same-Namespace ${name} when a Secret reference is supplied.`;
      }
      if (condition === "bound_secret") {
        if (operation?.operationId === "provisionAgent") {
          return `Requires ${action} permission on each existing ${name} reference supplied in provisioning inputs.`;
        }
        if (operation?.operationId === "createConfiguration") {
          return `Requires ${action} permission on each ${name} supplied in request body Secret bindings.`;
        }
        if (operation?.operationId === "updateConfiguration") {
          return `Requires ${action} permission on each ${name} bound by the resulting Configuration.`;
        }
        return `Requires ${action} permission on each bound ${name} when Secret bindings are present or selected.`;
      }
      if (condition === "missing_runtime_credentials") {
        return `Requires ${action} permission on the Agent when the selected Compute Driver must generate missing runtime credentials for its first deployment.`;
      }
      if (condition === "authenticated_plugin_discovery") {
        return `Requires ${action} permission on the Agent's bound ${name} when the selected Plugin Driver requires a discovery credential.`;
      }
      if (condition === "read_logs_alternative") {
        return `Without read_logs, ${action} permission on the requested ${name} also admits the read.`;
      }
      if (condition === "iam_binding_target") {
        return `Requires ${action} permission on the request body ${name} when the AccessBinding targets that resource kind.`;
      }
      switch (scope) {
        case "installation":
          return `Requires ${action} permission for ${name} resources in the Installation.`;
        case "namespace":
          return `Requires ${action} permission for ${name} resources in the requested Namespace.`;
        case "each_returned":
          return `Only ${name} resources with individual ${action} permission are returned.`;
        default:
          return `Requires ${action} permission on the requested ${name}.`;
      }
    })
    .join(" ");

  if (operation?.operationId === "deployAgent") {
    return `${description} Deployment also requires the owning Agent service principal to have operate permission on each bound Secret.`;
  }
  return description;
}

function clientInstallation(
  installation: Readonly<Installation>,
  computeDriver: Readonly<ComputeDriver> | undefined,
): Record<string, unknown> {
  const agentProvisioning = computeDriver?.agentProvisioning;
  const capabilities = {
    ...installation.capabilities,
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
  if (options.publicOrigin !== undefined) {
    try {
      const parsed = new URL(options.publicOrigin);
      publicOrigin = parsed.origin;
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
      // shape of a discriminated union a request chose (http/errors.ts). Neither is logged or
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
    schemaController: { compilersFactory: { buildSerializer: cachedResponseSerializers() } },
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
  app.addSchema(JsonValue);
  app.addSchema(PluginDriverIdentitySchema);
  app.addSchema(PluginApproversSchema);
  app.addSchema(PluginToolPolicySchema);
  app.addSchema(PluginToolDefaultsSchema);
  app.addSchema(PluginDesiredSelectionSchema);
  app.addSchema(PluginDesiredStateSchema);
  void app.register(swagger, {
    convertConstToEnum: false,
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
  const factory = options.auditEventFactory ?? new AuditEventFactory();
  const createAuthAccountOperation = {
    operationId: "createAuthAccount",
    method: "POST",
    path: "/api/auth/accounts",
    action: "openclaw.auth.accounts.create",
    iamAction: "administer",
    resourceKind: "installation",
    authorizationTarget: "installation",
    summary: "Create an administrator-controlled local auth account",
    tags: ["Authentication"],
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["email", "password"],
        properties: {
          email: { type: "string", minLength: 3, maxLength: 320 },
          password: { type: "string", minLength: 12, maxLength: 128 },
          name: { type: "string", minLength: 1, maxLength: 200 },
          roleId: { type: "string", minLength: 1, maxLength: 200 },
          github: {
            type: "object",
            additionalProperties: false,
            required: ["subject"],
            properties: { subject: { type: "string", pattern: "^[1-9][0-9]{0,19}$" } },
          },
        },
      },
    },
  } as unknown as OccApiRoute;
  const serviceKeyOperations = [
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
  ].map((operation) => ({
    ...operation,
    iamAction: "administer",
    resourceKind: "installation",
    authorizationTarget: "installation",
    tags: ["Authentication"],
    schema: {},
  })) as unknown as readonly OccApiRoute[];
  const runtimeLogLimiter = new RuntimeLogLimiter();
  const runtimeLogCursor =
    options.agentRuntimeLogs?.enabled === true
      ? createRuntimeLogCursorCodec(options.agentRuntimeLogs.cursorSecret)
      : undefined;
  function event(
    operation: OccApiRoute,
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
    const details =
      result?.details === undefined ? evidenceDetails : { ...evidenceDetails, ...result.details };
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
  function auditAction(operation: OccApiRoute, request: FastifyRequest): string {
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

  function workspaceFileRequestSignal(
    request: FastifyRequest,
    reply: FastifyReply,
    timeoutMs: number,
  ): { readonly signal: AbortSignal; readonly dispose: () => void } {
    const controller = new AbortController();
    const abort = (message: string) => {
      if (!controller.signal.aborted) {
        controller.abort(new Error(message));
      }
    };
    const timeout = setTimeout(
      () => abort(`The workspace file request exceeded its ${timeoutMs}ms deadline.`),
      timeoutMs,
    );
    timeout.unref?.();
    const onRequestAborted = () =>
      abort("The HTTP client disconnected before the workspace file request completed.");
    const onReplyClosed = () => {
      if (!reply.raw.writableEnded) {
        abort("The HTTP client disconnected before the workspace file request completed.");
      }
    };
    if (request.raw.aborted) {
      abort("The HTTP client disconnected before the workspace file request.");
    }
    request.raw.once("aborted", onRequestAborted);
    reply.raw.once("close", onReplyClosed);
    return {
      signal: controller.signal,
      dispose() {
        clearTimeout(timeout);
        request.raw.off("aborted", onRequestAborted);
        reply.raw.off("close", onReplyClosed);
      },
    };
  }

  async function withWorkspaceFileRequestSignal<T>(
    signal: AbortSignal,
    operation: Promise<T>,
    abortError: () => Error = dependencyUnavailable,
  ): Promise<T> {
    if (signal.aborted) {
      // The operation has already started; observe any rejection after the HTTP deadline.
      void operation.catch(() => {});
      throw abortError();
    }
    let abort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(abortError());
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([operation, aborted]);
    } finally {
      if (abort !== undefined) {
        signal.removeEventListener("abort", abort);
      }
    }
  }

  function workspaceFileAuditEvent(
    operation: OccApiRoute,
    request: FastifyRequest,
    resource: ResourceRef,
    context: RequestContext,
    filename: WorkspaceFileName,
    result?: { readonly outcome: "success" | "failure"; readonly reasonCode?: string },
  ): AuditEvent {
    const base = event(operation, request, resource, "mutation", context, undefined, result);
    return {
      ...base,
      details: {
        ...base.details,
        workspaceFileName: filename,
      },
    };
  }

  function validateWorkspaceFileBody(body: UpdateWorkspaceFileBody): void {
    const details: ErrorDetail[] = [];
    if (Buffer.byteLength(body.content, "utf8") > WORKSPACE_FILE_CONTENT_LIMIT) {
      details.push({ path: "/content", code: "TOO_LONG" });
    }
    const isWellFormed = (
      String.prototype as unknown as { isWellFormed: (this: string) => boolean }
    ).isWellFormed;
    if (body.content.includes("\u0000") || !isWellFormed.call(body.content)) {
      details.push({ path: "/content", code: "INVALID_VALUE" });
    }
    if (details.length > 0) {
      throw failure(
        400,
        "INVALID_REQUEST",
        "The request does not match the operation contract.",
        details,
      );
    }
  }

  async function requireInstallationAdmin(
    request: FastifyRequest,
    operation: OccApiRoute,
    context: RequestContext,
  ) {
    const target: ResourceRef = { kind: "installation", id: installationId };
    let selected: IAMDriver;
    let decision;
    try {
      selected = selectedIAMDriver();
      decision = await selected.authorize({
        principalId: context.actorId,
        action: "administer",
        resource: target,
      });
    } catch {
      throw dependencyUnavailable();
    }
    if (
      !decision ||
      typeof decision.allowed !== "boolean" ||
      decision.driverId !== selected.id ||
      !validAuthorizationEvidence(decision.evidence)
    ) {
      throw dependencyUnavailable();
    }
    if (!decision.allowed) {
      await denial(operation, request, "authorization_denial", context, decision.evidence);
      throw failure(403, "FORBIDDEN", "The exact platform operation was not authorized.");
    }
    return { selected, target, decision };
  }

  async function denial(
    operation: OccApiRoute,
    request: FastifyRequest,
    kind: "authorization_denial",
    context?: RequestContext,
    evidence?: AuthorizationEvidence,
    authorization?: NonNullable<AuthorizationDeniedError["authorization"]>,
    explanation?: {
      readonly decisionReason: string;
      readonly reasonCode?: string;
      readonly details: Readonly<Record<string, unknown>>;
    },
  ): Promise<void> {
    try {
      await options.auditSink.append(
        event(
          operation,
          request,
          operationTarget(operation, installationId, request.params as Record<string, unknown>),
          kind,
          context,
          evidence,
          explanation === undefined ? undefined : { outcome: "denied", ...explanation },
          authorization,
        ),
      );
    } catch {
      throw failure(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "A required platform dependency is unavailable.",
      );
    }
  }

  async function rejectedMutation(
    operation: OccApiRoute,
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
    } catch {
      throw failure(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "A required platform dependency is unavailable.",
      );
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

  const handlers: ResourceHandlers = {
    ...resourceHandlers,
    ...createAgentHandlers({
      resolveHarness: options.resolveHarness,
      requireCredentialCsrf: (request) => requireWorkspaceFileCsrf(request, true),
      rejectDeployment: (request, context) =>
        rejectedMutation(context.operation, request, context, "NAMESPACE_NOT_READY"),
    }),
  };

  app.addHook("onRequest", async (request, reply) => {
    requestStartedAt.set(request, process.hrtime.bigint());
    responseHeaders(reply, request.id);
    if (await nativeAdmin.interceptHttp(request, reply)) {
      return;
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
      ...(durationMs === undefined ? {} : { durationMs: Math.round(durationMs * 1000) / 1000 }),
    });
  });

  async function admit(request: FastifyRequest, operation: OccApiRoute): Promise<void> {
    if (
      request.headers[OCC_SERVICE_KEY_HEADER] !== undefined &&
      (operation === createAuthAccountOperation ||
        operation.operationId === "bootstrapInstallation")
    ) {
      throw failure(401, "UNAUTHENTICATED", "A human controller session is required.");
    }
    const params = request.params as Record<string, unknown>;
    if (
      Object.keys(request.query as Record<string, unknown>).length > 0 &&
      operation.operationId !== "listRepositoryOptions" &&
      operation.operationId !== "listAgentRepositoryOptions" &&
      operation.operationId !== "getAgentDeploymentRuntimeLogs"
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
    try {
      hostname = new URL(`http://${host ?? "127.0.0.1"}`).hostname;
    } catch {
      hostname = "";
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
    // Forwarded headers are never used for admission. They are tolerated only from a
    // configured trusted proxy, which adds them to every request it relays.
    const forwarded =
      options.trustedProxies?.trusts(remoteAddress) !== true &&
      Object.keys(request.headers).some(
        (name) => name === "forwarded" || name === "x-real-ip" || name.startsWith("x-forwarded-"),
      );
    if (
      forwarded ||
      (development.enabled &&
        (!LOOPBACK_HOSTNAMES.has(hostname) ||
          !originAllowed ||
          !trustedDevelopmentAddress(development, remoteAddress)))
    ) {
      throw failure(
        403,
        "FORBIDDEN",
        development.enabled
          ? "Development admission is restricted to direct loopback requests."
          : "Production admission requires a direct request.",
      );
    }

    let admitted: AdmittedCaller;
    try {
      admitted = await options.auth.admissionVerifier.verifyControllerRequest({
        requestId: request.id,
        method: request.method,
        routeId: operation.operationId,
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
      throw failure(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "A required platform dependency is unavailable.",
      );
    }

    admissions.set(request, admitted);
  }

  async function resolveIdentity(request: FastifyRequest, operation: OccApiRoute): Promise<void> {
    const admitted = admissions.get(request);
    if (!admitted) {
      throw failure(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "A required platform dependency is unavailable.",
      );
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
      throw failure(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "A required platform dependency is unavailable.",
      );
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
      throw failure(403, "FORBIDDEN", "The exact platform operation was not authorized.");
    }

    const context: RequestContext = {
      actorId: identity.id,
      issuer: admitted.externalIdentity.issuer,
      subject: admitted.externalIdentity.subject,
      admissionDecisionId: admitted.decisionId,
      operation,
    };
    contexts.set(request, context);
    if (
      admitted.method === "api_key" &&
      admitted.admittedScope.namespaceId !== undefined &&
      admitted.admittedScope.namespaceId !== (request.params as Record<string, unknown>).namespaceId
    ) {
      await denial(operation, request, "authorization_denial", context);
      throw failure(403, "FORBIDDEN", "The admitted Namespace does not match.");
    }
  }

  async function perform(
    request: FastifyRequest,
    reply: FastifyReply,
    operation: OccApiRoute,
  ): Promise<void> {
    const context = contexts.get(request);
    if (!context) {
      throw failure(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "A required platform dependency is unavailable.",
      );
    }
    const params = request.params as Record<string, string>;
    const body = request.body as Record<string, unknown> | undefined;
    if (body !== undefined) {
      validateConfiguration(body);
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
          throw failure(
            503,
            "DEPENDENCY_UNAVAILABLE",
            "A required platform dependency is unavailable.",
          );
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
          await created.createNamespace(context.actorId, {
            name: BOOTSTRAP_DEFAULT_NAMESPACE_NAME,
          });
          await unit.audit.append(
            event(operation, request, target, "bootstrap", context, decision.evidence),
          );
        });
        controller = created;
        reply.status(201).send({
          data: clientInstallation(created.installation, options.computeDriver),
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

    if (operation.operationId === "getInstallation") {
      reply.send({
        data: clientInstallation(
          await controller.getInstallation(context.actorId),
          options.computeDriver,
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
      reply.send({
        data: await controller.getNamespace(context.actorId, namespaceId),
        meta: { requestId: request.id },
      });
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
        );
      } else if (operation.operationId.startsWith("poll")) {
        result = await controller.pollAgentDeviceAuthorization(
          context.actorId,
          namespaceId,
          params.secretId as string,
          agentId,
        );
      } else {
        await controller.cancelAgentDeviceAuthorization(
          context.actorId,
          namespaceId,
          params.secretId as string,
          agentId,
        );
      }
      // Clients poll on the provider interval; audit the transition, not every pending poll.
      if (result?.status !== "pending" || operation.operationId.startsWith("start")) {
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

    if (operation.operationId === "discoverAgentPlugins") {
      const catalog = await controller.discoverAgentPlugins(context.actorId, namespaceId, {
        ...(body?.oauthLogin === undefined
          ? {}
          : { oauthLogin: body.oauthLogin as SecretReference }),
        ...(body?.secretRef === undefined
          ? { accessToken: body?.accessToken as string }
          : { secretRef: body.secretRef as SecretReference }),
        ...(body?.cursor === undefined ? {} : { cursor: body.cursor as string }),
        ...(body?.q === undefined ? {} : { q: body.q as string }),
      });
      reply.header("cache-control", "no-store");
      reply.send({ data: catalog, meta: { requestId: request.id } });
      return;
    }

    if (operation.operationId === "discoverAgentPluginDetails") {
      const plugin = await controller.discoverAgentPluginDetails(context.actorId, namespaceId, {
        ...(body?.oauthLogin === undefined
          ? {}
          : { oauthLogin: body.oauthLogin as SecretReference }),
        ...(body?.secretRef === undefined
          ? { accessToken: body?.accessToken as string }
          : { secretRef: body.secretRef as SecretReference }),
        pluginId: body?.pluginId as string,
      });
      reply.header("cache-control", "no-store");
      reply.send({ data: plugin, meta: { requestId: request.id } });
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
          ...(body?.oauthLogin === undefined
            ? {}
            : { oauthLogin: body.oauthLogin as SecretReference }),
          ...(body?.cursor === undefined ? {} : { cursor: body.cursor as string }),
          ...(body?.q === undefined ? {} : { q: body.q as string }),
        },
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
        {
          pluginId: body?.pluginId as string,
          ...(body?.oauthLogin === undefined
            ? {}
            : { oauthLogin: body.oauthLogin as SecretReference }),
        },
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
        context,
        request,
        reply,
        params,
        body,
        namespaceId,
        mutationEvent: (resource, details, authorization) => {
          const recorded = event(
            operation,
            request,
            resource,
            "mutation",
            context,
            undefined,
            undefined,
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

    if (
      operation.operationId === "getAgentWorkspaceFile" ||
      operation.operationId === "putAgentWorkspaceFile"
    ) {
      const deadlineMs = workspaceFileRequestTimeoutMs;
      const workspaceFileSignal = workspaceFileRequestSignal(request, reply, deadlineMs);
      const signal = workspaceFileSignal.signal;
      const deadline = new Date(Date.now() + deadlineMs);
      try {
        requireWorkspaceFileCsrf(request, operation.operationId === "putAgentWorkspaceFile");
        if (options.workspaceFilesAccess === undefined) {
          throw dependencyUnavailable();
        }
        const filename = params.name;
        if (filename === undefined || !isAllowedWorkspaceFileName(filename)) {
          throw failure(
            400,
            "INVALID_REQUEST",
            "The request does not match the operation contract.",
          );
        }
        if (signal.aborted) {
          throw dependencyUnavailable();
        }
        const { agent, revision } = await withWorkspaceFileRequestSignal(
          signal,
          operation.operationId === "getAgentWorkspaceFile"
            ? controller.getReadableActiveAgentRevision(context.actorId, namespaceId, agentId)
            : controller.getOperableActiveAgentRevision(context.actorId, namespaceId, agentId),
        );
        const target = { kind: "agent" as const, id: agent.id, namespaceId: agent.namespaceId };
        if (signal.aborted) {
          throw dependencyUnavailable();
        }

        if (operation.operationId === "getAgentWorkspaceFile") {
          let result: ControllerWorkspaceFileReadResult;
          try {
            if (signal.aborted) {
              throw dependencyUnavailable();
            }
            result = await withWorkspaceFileRequestSignal(
              signal,
              options.workspaceFilesAccess.read({
                revision,
                filename,
                signal,
                deadline,
              }),
            );
          } catch {
            throw dependencyUnavailable();
          }
          if (result.status === "missing") {
            throw failure(404, "NOT_FOUND", "The requested workspace file was not found.");
          }
          if (result.status === "unavailable") {
            throw dependencyUnavailable();
          }
          const isWellFormed = (
            String.prototype as unknown as { isWellFormed: (this: string) => boolean }
          ).isWellFormed;
          if (
            Buffer.byteLength(result.file.content, "utf8") > WORKSPACE_FILE_CONTENT_LIMIT ||
            result.file.content.includes("\u0000") ||
            !isWellFormed.call(result.file.content)
          ) {
            throw dependencyUnavailable();
          }
          reply.send({
            data: { name: filename, content: result.file.content },
            meta: { requestId: request.id },
          });
          return;
        }

        const writeBody = body as unknown as UpdateWorkspaceFileBody;
        validateWorkspaceFileBody(writeBody);
        let result: ControllerWorkspaceFileWriteResult;
        try {
          if (signal.aborted) {
            throw dependencyUnavailable();
          }
          result = await withWorkspaceFileRequestSignal(
            signal,
            options.workspaceFilesAccess.write({
              revision,
              filename,
              content: writeBody.content,
              signal,
              deadline,
            }),
            () =>
              new ControllerWorkspaceFileUnknownOutcomeError(
                "The workspace file write reached the OCC request deadline before the controller observed its outcome.",
              ),
          );
        } catch (error) {
          if (error instanceof ControllerWorkspaceFileUnknownOutcomeError) {
            try {
              await withWorkspaceFileRequestSignal(
                signal,
                options.auditSink.append(
                  workspaceFileAuditEvent(operation, request, target, context, filename, {
                    outcome: "failure",
                    reasonCode: "UNKNOWN_OUTCOME",
                  }),
                ),
                () => new ControllerWorkspaceFileUnknownOutcomeError(error.message),
              );
            } catch {
              throw failure(503, "UNKNOWN_OUTCOME", error.message);
            }
            throw failure(503, "UNKNOWN_OUTCOME", error.message);
          }
          try {
            await withWorkspaceFileRequestSignal(
              signal,
              options.auditSink.append(
                workspaceFileAuditEvent(operation, request, target, context, filename, {
                  outcome: "failure",
                  reasonCode: "DEPENDENCY_UNAVAILABLE",
                }),
              ),
            );
          } catch {
            throw dependencyUnavailable();
          }
          throw dependencyUnavailable();
        }
        if (result.status === "missing") {
          try {
            await withWorkspaceFileRequestSignal(
              signal,
              options.auditSink.append(
                workspaceFileAuditEvent(operation, request, target, context, filename, {
                  outcome: "failure",
                  reasonCode: "FILE_MISSING",
                }),
              ),
            );
          } catch {
            throw dependencyUnavailable();
          }
          throw failure(404, "NOT_FOUND", "The requested workspace file was not found.");
        }
        if (result.status === "unavailable") {
          try {
            await withWorkspaceFileRequestSignal(
              signal,
              options.auditSink.append(
                workspaceFileAuditEvent(operation, request, target, context, filename, {
                  outcome: "failure",
                  reasonCode: "DEPENDENCY_UNAVAILABLE",
                }),
              ),
            );
          } catch {
            throw dependencyUnavailable();
          }
          throw dependencyUnavailable();
        }
        try {
          await withWorkspaceFileRequestSignal(
            signal,
            options.auditSink.append(
              workspaceFileAuditEvent(operation, request, target, context, filename, {
                outcome: "success",
              }),
            ),
            () =>
              new ControllerWorkspaceFileUnknownOutcomeError(
                "The workspace file was written, but its final audit outcome could not be persisted before the request ended.",
              ),
          );
        } catch {
          throw failure(
            503,
            "UNKNOWN_OUTCOME",
            "The workspace file was written, but its final audit outcome could not be persisted.",
          );
        }
        reply.send({
          data: {
            name: filename,
            size: Buffer.byteLength(writeBody.content, "utf8"),
          },
          meta: { requestId: request.id },
        });
        return;
      } finally {
        workspaceFileSignal.dispose();
      }
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
        const page = await controller!.readAgentRuntimeLogs(
          context.actorId,
          namespaceId,
          agentId,
          params.deploymentId as string,
          runtimeLogQuery(query),
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
              `attachment; filename="${runtimeLogDownloadFileName(page, agentId)}"`,
            )
            .send(runtimeLogDownloadBody(page, agentId));
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
    const meta = {
      type: "object",
      additionalProperties: false,
      required: ["requestId"],
      properties: { requestId: { type: "string" } },
    };
    const envelope = (data: Record<string, unknown>) => ({
      type: "object",
      additionalProperties: false,
      required: ["data", "meta"],
      properties: { data, meta },
    });
    const error = {
      type: "object",
      additionalProperties: false,
      required: ["error", "meta"],
      properties: {
        error: {
          type: "object",
          additionalProperties: false,
          required: ["code", "message"],
          properties: {
            code: { type: "string" },
            message: { type: "string" },
            // Schema 400s point at the rejected field; without this the serializer drops it.
            details: { type: "array", maxItems: 32, items: ErrorDetailSchema },
          },
        },
        meta,
      },
    };
    const responses = (success: Record<string, unknown>, status = 200) => ({
      [status]: { description: status === 201 ? "Created" : "OK", ...envelope(success) },
      401: { description: "Unauthorized", ...error },
      503: { description: "Service Unavailable", ...error },
    });
    // Every route that reads a body answers an oversized one 413 and a non-JSON one 415.
    const bodyErrors = {
      413: { description: "Payload Too Large", ...error },
      415: { description: "Unsupported Media Type", ...error },
    };
    const accountBody = (
      createAuthAccountOperation.schema as {
        readonly body: { readonly properties: Record<string, unknown> };
      }
    ).body;
    const account = {
      type: "object",
      additionalProperties: true,
      required: ["id", "email", "name", "principalId"],
      properties: {
        id: { type: "string" },
        email: { type: "string", format: "email" },
        name: { type: "string" },
        principalId: { type: "string" },
      },
    };

    for (const operation of serviceKeyOperations) {
      const creating = operation.method === "POST";
      const serviceKey = {
        type: "object",
        additionalProperties: false,
        required: ["id", "servicePrincipalId", "name", "expiresAt", "key"],
        properties: {
          id: { type: "string" },
          servicePrincipalId: { type: "string" },
          namespaceId: { type: "string" },
          name: { type: "string" },
          expiresAt: { type: "string", format: "date-time" },
          key: { type: "string" },
        },
      };
      routes.route({
        method: operation.method as HTTPMethods,
        url: operation.path,
        schema: {
          operationId: operation.operationId,
          summary: operation.summary,
          description: creating
            ? "Requires a session or Installation-scoped service key with administer on the Installation. Issues a Better Auth key for an existing non-Agent ServicePrincipal in its exact scope when the caller already holds every IAM grant of that ServicePrincipal at the same or a broader scope; creates no identity or IAM grant. The plaintext key is returned only here."
            : "Requires a session or Installation-scoped service key with administer on the Installation, plus every IAM grant of the key's ServicePrincipal, as for issuance. Deletes the stored Better Auth key; subsequent requests cannot authenticate with it.",
          tags: [...operation.tags],
          security: [{ sessionCookie: [] }, { serviceApiKey: [] }],
          "x-openclaw-permissions": [
            { action: "administer", resourceKind: "installation", scope: "requested" },
          ],
          ...(creating
            ? {
                body: {
                  type: "object",
                  additionalProperties: false,
                  required: ["servicePrincipalId", "name"],
                  properties: {
                    servicePrincipalId: { type: "string", minLength: 1, maxLength: 200 },
                    namespaceId: { type: "string", pattern: RESOURCE_ID.namespaceId.source },
                    name: { type: "string", minLength: 1, maxLength: 32, pattern: "\\S" },
                    expiresIn: {
                      type: "integer",
                      minimum: 86400,
                      maximum: 31536000,
                      description: "Lifetime in seconds; defaults to 30 days.",
                    },
                  },
                },
              }
            : {
                params: {
                  type: "object",
                  additionalProperties: false,
                  required: ["keyId"],
                  properties: { keyId: { type: "string", minLength: 1, maxLength: 200 } },
                },
              }),
          response: {
            ...responses(
              creating
                ? serviceKey
                : {
                    type: "object",
                    additionalProperties: false,
                    required: ["id", "revoked"],
                    properties: {
                      id: { type: "string" },
                      revoked: { type: "boolean", const: true },
                    },
                  },
              creating ? 201 : 200,
            ),
            400: { description: "Bad Request", ...error },
            403: { description: "Forbidden", ...error },
            404: { description: "Not Found", ...error },
            409: { description: "Conflict", ...error },
            ...(creating ? bodyErrors : {}),
          },
        } as DocumentedFastifySchema,
        onRequest: async (request) => admit(request, operation),
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
          const audit = (key: { id: string; servicePrincipalId: string }) => {
            const base = event(operation, request, target, "mutation", context, decision.evidence);
            return {
              ...base,
              details: {
                ...base.details,
                serviceKeyId: key.id,
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
            } catch {
              // Never return an unaudited credential; remove it if audit persistence fails.
              if (key) {
                await options.auth.revokeServiceKey(key).catch(() => {});
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
            required: ["github", "google", "oidc", "password", "sessionBinding"],
            properties: {
              github: { type: "boolean" },
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
        const github = options.auth.githubEnabled === true;
        const google = options.auth.googleEnabled === true;
        const oidc = options.auth.oidcEnabled === true;
        const password = options.auth.passwordSignIn !== "recovery-only";
        return {
          data: {
            github,
            google,
            oidc,
            ...(oidc && options.auth.oidcSignIn !== undefined
              ? { oidcSignIn: options.auth.oidcSignIn }
              : {}),
            password,
            sessionBinding: github || google || oidc,
          },
          meta: { requestId: request.id },
        };
      },
    );
    // Handlers resolve on each request, as before: options.auth is read lazily.
    const externalSignInProviders = [
      { name: "github", label: "GitHub", article: "a", operation: "GitHub" },
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

    const accountParams = {
      type: "object",
      additionalProperties: false,
      required: ["userId"],
      properties: { userId: { type: "string", minLength: 1, maxLength: 200 } },
    };
    const accountReadOperation = {
      operationId: "getAuthAccount",
      method: "GET",
      path: "/api/auth/accounts/:userId",
      action: "openclaw.auth.accounts.read",
      iamAction: "administer",
      resourceKind: "installation",
      authorizationTarget: "installation",
      tags: ["Authentication"],
      summary: "Inspect current human account state",
      schema: {},
    } as unknown as OccApiRoute;
    // Account state and its controls live in the guarded external sign-in profile; the
    // password-only profile has no account version, disabled state, or bound sessions.
    function accountControlsUnsupported(): RequestFailure {
      return failure(
        409,
        "RESOURCE_CONFLICT",
        "Account controls require GitHub, Google or OIDC sign-in; the password-only profile does not support them.",
      );
    }
    async function humanAccountActor(
      request: FastifyRequest,
      operation: OccApiRoute,
      context: RequestContext,
      targetUserId?: string,
    ) {
      const admitted = admissions.get(request);
      if (
        admitted?.method !== "session" ||
        admitted.session.userId !== context.subject ||
        publicOrigin === undefined ||
        request.headers.origin !== publicOrigin
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
      };
    }
    routes.get(
      accountReadOperation.path,
      {
        schema: {
          operationId: accountReadOperation.operationId,
          summary: accountReadOperation.summary,
          description:
            "Requires a current human Native IAM Installation administrator and trusted Origin. Returns guarded present state, not a receipt for any prior operation.",
          tags: ["Authentication"],
          security: [{ sessionCookie: [] }],
          "x-openclaw-permissions": [
            { action: "administer", resourceKind: "installation", scope: "requested" },
          ],
          params: accountParams,
          response: {
            ...responses({
              type: "object",
              additionalProperties: false,
              required: ["userId", "principalId", "version", "disabled", "methods"],
              properties: {
                userId: { type: "string" },
                principalId: { type: "string" },
                version: { type: "integer", minimum: 1 },
                disabled: { type: "boolean" },
                methods: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["methodId", "providerId", "subject"],
                    properties: {
                      methodId: { type: "string" },
                      providerId: { type: "string" },
                      subject: { type: "string" },
                    },
                  },
                },
              },
            }),
            403: { description: "Forbidden", ...error },
            404: { description: "Not Found", ...error },
            409: { description: "Conflict", ...error },
          },
        },
        onRequest: async (request) => admit(request, accountReadOperation),
        preValidation: async (request) => resolveIdentity(request, accountReadOperation),
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
        operationName: "github",
        path: "/api/auth/accounts/:userId/providers/github",
        operationId: "attachGitHubIdentity",
        summary: "Attach an exact GitHub identity to an existing account",
      },
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
    const methodParams = {
      type: "object",
      additionalProperties: false,
      required: ["userId", "methodId"],
      properties: {
        userId: { type: "string", minLength: 1, maxLength: 200 },
        methodId: { type: "string", minLength: 1, maxLength: 200 },
      },
    };
    for (const { operationName, path, operationId, summary } of accountOperations) {
      const operation = {
        operationId,
        method: "POST",
        path,
        action: `openclaw.auth.accounts.${operationName}`,
        iamAction: "administer",
        resourceKind: "installation",
        authorizationTarget: "installation",
        tags: ["Authentication"],
        summary,
        schema: {},
      } as unknown as OccApiRoute;
      routes.post(
        operation.path,
        {
          schema: {
            operationId: operation.operationId,
            summary: operation.summary,
            description:
              "Requires a current human Native IAM Installation administrator who holds every grant of the target account's Principal, trusted Origin and expectedVersion from a guarded account read. Commits state and audit together. An unknown outcome must be inspected without automatic retry; present state does not attribute the earlier request.",
            tags: [...operation.tags],
            security: [{ sessionCookie: [] }],
            "x-openclaw-permissions": [
              { action: "administer", resourceKind: "installation", scope: "requested" },
            ],
            params: operationName === "detach" ? methodParams : accountParams,
            body: {
              type: "object",
              additionalProperties: false,
              required:
                operationName === "github" || operationName === "google" || operationName === "oidc"
                  ? ["subject", "expectedVersion"]
                  : ["expectedVersion"],
              properties: {
                expectedVersion: { type: "integer", minimum: 1, maximum: 2147483647 },
                ...(operationName === "github"
                  ? { subject: { type: "string", pattern: "^[1-9][0-9]{0,19}$" } }
                  : operationName === "google" || operationName === "oidc"
                    ? { subject: { type: "string", pattern: "^[\\x21-\\x7E]{1,255}$" } }
                    : {}),
              },
            },
            response: {
              ...responses({
                type: "object",
                additionalProperties: false,
                required: ["userId"],
                properties: { userId: { type: "string" } },
              }),
              400: { description: "Bad Request", ...error },
              403: { description: "Forbidden", ...error },
              404: { description: "Not Found", ...error },
              409: { description: "Conflict", ...error },
              ...bodyErrors,
            },
          },
          onRequest: async (request) => admit(request, operation),
          preValidation: async (request) => resolveIdentity(request, operation),
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
          if (operationName === "github") {
            if (!options.auth.attachGitHub || !options.auth.githubEnabled) {
              throw failure(409, "RESOURCE_CONFLICT", "GitHub sign-in is not configured.");
            }
            const { subject } = request.body as { subject: string };
            await options.auth.attachGitHub(userId, subject, actor, expectedVersion);
          } else if (operationName === "google") {
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

    const recoveryResponse = {
      type: "object",
      additionalProperties: false,
      required: ["userId", "principalId", "methodId"],
      properties: {
        userId: { type: "string" },
        principalId: { type: "string" },
        methodId: { type: "string" },
      },
    };
    const recoveryReadOperation = {
      operationId: "getAuthRecovery",
      method: "GET",
      path: "/api/auth/recovery",
      action: "openclaw.auth.recovery.read",
      iamAction: "administer",
      resourceKind: "installation",
      authorizationTarget: "installation",
      tags: ["Authentication"],
      summary: "Inspect the recovery account designation",
      schema: {},
    } as unknown as OccApiRoute;
    routes.get(
      recoveryReadOperation.path,
      {
        schema: {
          operationId: recoveryReadOperation.operationId,
          summary: recoveryReadOperation.summary,
          description:
            "Requires a current human Native IAM Installation administrator and trusted Origin. Returns the present designation, whose password the database protects; not a receipt for any prior operation.",
          tags: ["Authentication"],
          security: [{ sessionCookie: [] }],
          "x-openclaw-permissions": [
            { action: "administer", resourceKind: "installation", scope: "requested" },
          ],
          response: {
            ...responses(recoveryResponse),
            403: { description: "Forbidden", ...error },
            404: { description: "Not Found", ...error },
            409: { description: "Conflict", ...error },
          },
        },
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

    const recoveryReplaceOperation = {
      operationId: "replaceAuthRecovery",
      method: "POST",
      path: "/api/auth/recovery",
      action: "openclaw.auth.recovery.replace",
      iamAction: "administer",
      resourceKind: "installation",
      authorizationTarget: "installation",
      tags: ["Authentication"],
      summary: "Move the recovery designation to another administrator",
      schema: {},
    } as unknown as OccApiRoute;
    routes.post(
      recoveryReplaceOperation.path,
      {
        schema: {
          operationId: recoveryReplaceOperation.operationId,
          summary: recoveryReplaceOperation.summary,
          description:
            "Requires a current human Native IAM Installation administrator and trusted Origin who holds every IAM grant of the current holder's Principal (else 403). The target must be an enrolled, enabled account with one password whose Principal administers the Installation. expectedCurrentUserId comes from the recovery read and expectedVersion from the target's account read. Commits state and audit together; an unknown outcome must be inspected without automatic retry.",
          tags: ["Authentication"],
          security: [{ sessionCookie: [] }],
          "x-openclaw-permissions": [
            { action: "administer", resourceKind: "installation", scope: "requested" },
          ],
          body: {
            type: "object",
            additionalProperties: false,
            required: ["userId", "expectedCurrentUserId", "expectedVersion"],
            properties: {
              userId: { type: "string", minLength: 1, maxLength: 200 },
              expectedCurrentUserId: { type: "string", minLength: 1, maxLength: 200 },
              expectedVersion: { type: "integer", minimum: 1, maximum: 2147483647 },
            },
          },
          response: {
            ...responses({
              ...recoveryResponse,
              required: [...recoveryResponse.required, "changed"],
              properties: { ...recoveryResponse.properties, changed: { type: "boolean" } },
            }),
            400: { description: "Bad Request", ...error },
            403: { description: "Forbidden", ...error },
            404: { description: "Not Found", ...error },
            409: { description: "Conflict", ...error },
            ...bodyErrors,
          },
        },
        onRequest: async (request) => admit(request, recoveryReplaceOperation),
        preValidation: async (request) => resolveIdentity(request, recoveryReplaceOperation),
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
        // check runs before the State transaction. That is sound because Installation-scoped access
        // bindings have no online revocation path (deleteAccessBinding is Namespace-scoped), and
        // every controller start re-checks the current holder's authority.
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

    const enrolOperation = {
      operationId: "enrolAuthAccount",
      method: "POST",
      path: "/api/auth/accounts/:userId/enrol",
      action: "openclaw.auth.accounts.enrol",
      iamAction: "administer",
      resourceKind: "installation",
      authorizationTarget: "installation",
      tags: ["Authentication"],
      summary: "Enrol an existing account that activation skipped",
      schema: {},
    } as unknown as OccApiRoute;
    routes.post(
      enrolOperation.path,
      {
        schema: {
          operationId: enrolOperation.operationId,
          summary: enrolOperation.summary,
          description:
            "Requires a current human Native IAM Installation administrator and trusted Origin. The account must already have its IAM Principal and exactly one password. Idempotent; enrolment grants no access beyond the account's existing IAM bindings.",
          tags: ["Authentication"],
          security: [{ sessionCookie: [] }],
          "x-openclaw-permissions": [
            { action: "administer", resourceKind: "installation", scope: "requested" },
          ],
          params: accountParams,
          response: {
            ...responses({
              type: "object",
              additionalProperties: false,
              required: ["userId", "principalId", "version", "created"],
              properties: {
                userId: { type: "string" },
                principalId: { type: "string" },
                version: { type: "integer", minimum: 1 },
                created: { type: "boolean" },
              },
            }),
            403: { description: "Forbidden", ...error },
            404: { description: "Not Found", ...error },
            409: { description: "Conflict", ...error },
          },
        },
        onRequest: async (request) => admit(request, enrolOperation),
        preValidation: async (request) => resolveIdentity(request, enrolOperation),
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
            "Authenticates a local account and issues a user session cookie. In the password-only profile, repeated failed attempts for one email, or from one client address behind a trusted proxy, are limited and return 429; with GitHub, Google or OIDC sign-in, every attempt counts, successful ones included. A successful sign-in also sets an HttpOnly known-device cookie; later attempts for that email from the same browser spend the browser's own budget instead of the email's. The cookie never authenticates.",
          tags: ["Authentication"],
          security: [],
          body: {
            type: "object",
            additionalProperties: false,
            required: ["email", "password"],
            properties: {
              email: accountBody.properties.email,
              password: accountBody.properties.password,
            },
          },
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
    routes.post(
      "/api/auth/accounts",
      {
        schema: {
          ...createAuthAccountOperation.schema,
          operationId: createAuthAccountOperation.operationId,
          summary: createAuthAccountOperation.summary,
          description:
            "Requires administer permission on the Installation. Creates a Better Auth account and an explicit IAM Principal in one transaction. Supplying roleId also creates a binding to that existing IAM Role; omitting roleId creates no grants. Public signup remains disabled. An optional github.subject attaches that GitHub identity in the same transaction; it conflicts when GitHub sign-in is not configured or the identity is already assigned.",
          tags: [...createAuthAccountOperation.tags],
          security: [{ sessionCookie: [] }],
          "x-openclaw-permissions": [
            { action: "administer", resourceKind: "installation", scope: "requested" },
          ],
          response: {
            ...responses(account, 201),
            400: { description: "Bad Request", ...error },
            403: { description: "Forbidden", ...error },
            409: { description: "Conflict", ...error },
            ...bodyErrors,
          },
        },
        onRequest: async (request) => admit(request, createAuthAccountOperation),
        preValidation: async (request) => resolveIdentity(request, createAuthAccountOperation),
      },
      async (request, reply) => {
        const context = contexts.get(request);
        if (!context) {
          throw failure(
            503,
            "DEPENDENCY_UNAVAILABLE",
            "A required platform dependency is unavailable.",
          );
        }
        if (options.provisionAuthAccount === undefined) {
          throw failure(
            503,
            "DEPENDENCY_UNAVAILABLE",
            "A required platform dependency is unavailable.",
          );
        }

        const body = request.body as Record<string, unknown> | undefined;
        const email = body?.email;
        const password = body?.password;
        const name = body?.name;
        const roleId = body?.roleId;
        const github = body?.github as { subject?: unknown } | undefined;
        if (
          !isNonEmptyString(email) ||
          !isNonEmptyString(password) ||
          (roleId !== undefined && !isNonEmptyString(roleId)) ||
          (name !== undefined && !isNonEmptyString(name)) ||
          (github !== undefined && !isNonEmptyString(github.subject))
        ) {
          throw failure(
            400,
            "INVALID_REQUEST",
            "The request does not match the operation contract.",
          );
        }

        const { target, decision } = await requireInstallationAdmin(
          request,
          createAuthAccountOperation,
          context,
        );

        const githubProviderId = options.auth.githubEnabled
          ? options.auth.githubProviderId
          : undefined;
        if (github !== undefined && githubProviderId === undefined) {
          throw failure(409, "RESOURCE_CONFLICT", "GitHub sign-in is not configured.");
        }
        const external =
          github === undefined
            ? undefined
            : { providerId: githubProviderId!, subject: github.subject as string };
        const prepared = await options.auth.prepareAccount({
          email,
          password,
          ...(name === undefined ? {} : { name }),
        });
        const seed = options.auth.principalSeed(
          prepared,
          roleId === undefined ? { grant: "none" } : { roleId },
        );
        const baseAuditEvent = event(
          createAuthAccountOperation,
          request,
          target,
          "mutation",
          context,
          decision.evidence,
        );
        // Record who was enrolled and what they were granted; never the email or password.
        const auditEvent: AuditEvent = {
          ...baseAuditEvent,
          details: {
            ...baseAuditEvent.details,
            principalId: seed.principal.id,
            ...(roleId === undefined ? { grant: "none" } : { roleId }),
          },
        };
        try {
          await options.provisionAuthAccount(seed, auditEvent, prepared, external);
        } catch (error) {
          // The account, Principal and audit commit in one transaction, so nothing is
          // compensated here. Dependency errors keep their class: an unknown COMMIT
          // outcome must reach the caller as unknown, never as a plain outage.
          throw error instanceof RequestFailure || error instanceof DependencyUnavailableError
            ? error
            : error instanceof UserAlreadyExistsError
              ? failure(409, "RESOURCE_CONFLICT", "The requested platform resource already exists.")
              : external !== undefined && error instanceof ResourceConflictError
                ? failure(409, "RESOURCE_CONFLICT", "The external identity is already assigned.")
                : error instanceof AuthAccountRoleNotFoundError ||
                    error instanceof AuthAccountRoleInvalidError
                  ? failure(
                      400,
                      "INVALID_REQUEST",
                      "The request does not match the operation contract.",
                    )
                  : new DependencyUnavailableError(
                      error instanceof Error ? error.message : "Auth account provisioning failed.",
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
    routes.addSchema(ErrorResponse);
    routes.addSchema(AgentDeploymentDiagnosticsResponse);
    routes.addSchema(AgentRuntimeResponse);
    routes.addSchema(AgentRuntimeLogsResponse);
    routes.addSchema(AgentRuntimeCredentialResponse);
    routes.addSchema(SecretResponse);
    routes.addSchema(CredentialSourceResponse);
    routes.route({
      method: "GET",
      url: nativeAdminStatusOperation.path,
      schema: nativeAdminStatusSchema,
      onRequest: async (request) => admit(request, nativeAdminStatusOperation),
      preHandler: async (request) => resolveIdentity(request, nativeAdminStatusOperation),
      handler: nativeAdmin.status,
    });
    for (const operation of occApiRoutes) {
      const permissions = requiredPermissions(operation);
      const schema: DocumentedFastifySchema = {
        ...operation.schema,
        operationId: operation.operationId,
        summary: operation.summary,
        description: permissionDescription(permissions, operation),
        tags: [...operation.tags],
        "x-openclaw-permissions": permissions,
        ...(operation.operationId === "bootstrapInstallation"
          ? { security: [{ sessionCookie: [] }] }
          : {}),
      } as DocumentedFastifySchema;
      routes.route({
        method: operation.method as HTTPMethods,
        url: operation.path,
        ...(operation.operationId === "putAgentWorkspaceFile"
          ? { bodyLimit: WORKSPACE_FILE_BODY_LIMIT }
          : operation.operationId === "createAgent" || operation.operationId === "provisionAgent"
            ? { bodyLimit: options.maxBodyBytes ?? AGENT_CREATE_BODY_LIMIT }
            : {}),
        schema,
        onRequest: async (request) => admit(request, operation),
        preValidation: async (request) => {
          const hasRequestBody =
            request.body !== undefined ||
            Number(request.headers["content-length"] ?? 0) > 0 ||
            request.headers["transfer-encoding"] !== undefined;
          if (!Object.hasOwn(operation.schema, "body") && hasRequestBody) {
            throw failure(
              400,
              "INVALID_REQUEST",
              "The request does not match the operation contract: this operation accepts no request body.",
            );
          }
          const unstorable =
            unstorableTextFailure("params", request.params) ??
            unstorableTextFailure("body", request.body);
          if (unstorable !== undefined) {
            throw unstorable;
          }
        },
        preHandler: async (request) => resolveIdentity(request, operation),
        handler: async (request, reply) => perform(request, reply, operation),
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
    const asset = await readConsoleAsset(pathname);
    reply.header("content-security-policy", CONSOLE_CONTENT_SECURITY_POLICY);
    reply.header("content-type", asset.contentType);
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
    canonicalFailure(
      reply,
      failure(404, "NOT_FOUND", "The requested platform resource was not found."),
    );
  });

  app.setErrorHandler(async (error, request, reply) => {
    let mapped = requestFailure(error);
    if (error instanceof RuntimeLogsError && error.retryAfterSeconds !== undefined) {
      reply.header("retry-after", String(error.retryAfterSeconds));
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
            await denial(
              context.operation,
              request,
              "authorization_denial",
              context,
              error.evidence,
              error.authorization,
              error instanceof DeletionRetryOwnedError
                ? {
                    decisionReason:
                      "A deletion can be retried only by its initiating actor while it holds delete.",
                    details: { initiatingActorId: error.initiatingActorId },
                  }
                : undefined,
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
        host: "auth.openai.com",
        reason: error.reason,
        failure: error.failure,
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
    canonicalFailure(reply, mapped);
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

import { isNonEmptyString } from "@openclaw-enterprise/utils";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyBaseLogger,
  type FastifyReply,
  type FastifyRequest,
  type FastifySchema,
  type HTTPMethods,
  type InjectOptions,
} from "fastify";
import swagger from "@fastify/swagger";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import ajvFormats from "ajv-formats";
import { AuditEventFactory, type AuditSink } from "@openclaw-enterprise/audit";
import { AuthAccountRoleNotFoundError, type AuthPrincipalSeed } from "@openclaw-enterprise/iam";
import {
  harnessAuthBindingFromSnapshot,
  WORKSPACE_DEFAULTS_ID,
  normalizeInitialWorkspaceFiles,
  type InitialWorkspaceFiles,
  ErrorResponse,
  AgentRuntimeCredentialResponse,
  JsonValue,
  PluginDesiredSelectionSchema,
  PluginDesiredStateSchema,
  PluginDriverIdentitySchema,
  PluginToolPolicySchema,
  SecretResponse,
  occApiRoutes,
  type Agent,
  type ProvisionAgentBody,
  type AgentRevision,
  type AgentRuntimeCredentialsBody,
  type AuditEvent,
  type AuthorizationEvidence,
  type ConfigurationDriver,
  type ComputeDriver,
  type HarnessExecutionMode,
  type HarnessAuthBinding,
  type IAMDriver,
  type Installation,
  type OccApiRoute,
  type PermissionAction,
  type BackendSummary,
  type RepositoryBindingRequest,
  type ResourceKind,
  type ResourceRef,
  type SandboxDriver,
  type SecretDriver,
  type UpdateWorkspaceFileBody,
  type WorkspaceFileName,
} from "@openclaw-enterprise/contracts";
import {
  AuthorizationDeniedError,
  BOOTSTRAP_DEFAULT_NAMESPACE_NAME,
  DependencyUnavailableError,
  NamespaceNotReadyError,
  RepositoryOptionsUnavailableError,
  ResourceConflictError,
  type DeploymentStatusResult,
  type AgentProvisioningProgress,
  type ProvisionAgentInput,
  type HarnessResolver,
  type OpenClawController,
} from "@openclaw-enterprise/occ";
import type { AdmittedCaller } from "./admission/admission-verifier.ts";
import {
  hostnameMatchesSharedCookieDomain,
  normalizeSharedCookieDomain,
  OCC_SERVICE_KEY_HEADER,
  type ControllerAuth,
} from "./auth/index.ts";
import { CONSOLE_CONTENT_SECURITY_POLICY, readConsoleAsset } from "./console-assets.ts";
import {
  ControllerWorkspaceFileUnknownOutcomeError,
  isAllowedWorkspaceFileName,
  type ControllerWorkspaceFilesAccess,
  type ControllerWorkspaceFileReadResult,
  type ControllerWorkspaceFileWriteResult,
} from "./gateway/contracts.ts";
import {
  deriveNativeAdminHost,
  nativeAdminConfigurationSupported,
  nativeAdminGatewayHttpBase,
  nativeAdminTarget,
  normalizeNativeAdminDomain,
  type NativeAdminAccessConfig,
  type NativeAdminTarget,
} from "./gateway/native-admin.ts";
import {
  proxyNativeAdminHttp as streamNativeAdminHttp,
  proxyNativeAdminWebSocket,
  type NativeAdminProxyContext,
  type NativeAdminWebSocketCloseCause,
  type NativeAdminWebSocketCloseReason,
} from "./gateway/native-admin-proxy.ts";
import {
  canonicalFailure,
  failure,
  isAuthorizationDenied,
  isDependencyUnavailable,
  jsonPointer,
  RequestFailure,
  requestFailure,
  responseHeaders,
  type ErrorDetail,
} from "./http/errors.ts";
import { configurationHandlers } from "./http/configurations.ts";
import { presetHandlers } from "./http/presets.ts";
import { secretHandlers } from "./http/secrets.ts";
import { iamHandlers } from "./http/iam.ts";
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
  readonly secretDriver?: SecretDriver;
  readonly sandboxDriver?: SandboxDriver;
  readonly resolveHarness: HarnessResolver;
  readonly auditSink: AuditSink;
  readonly backendSummaries?: readonly BackendSummary[];
  readonly development: DevelopmentAdmission;
  readonly maxBodyBytes?: number;
  readonly auth: ControllerAuth;
  readonly workspaceFilesAccess?: ControllerWorkspaceFilesAccess;
  readonly workspaceFileRequestTimeoutMs?: number;
  readonly nativeAdmin?: NativeAdminAccessConfig;
  readonly nativeAdminGatewayApiKey?: () => Promise<string>;
  readonly publicOrigin?: string;
  readonly provisionAuthAccount?: (
    seed: AuthPrincipalSeed,
    auditEvent: AuditEvent,
  ) => Promise<void>;
  readonly auditEventFactory?: AuditEventFactory;
  readonly logger?: FastifyBaseLogger;
}

export interface ControllerApp {
  fetch(request: Request): Promise<Response>;
}

interface NativeAdminProxyResolution {
  readonly parentSessionId: string;
  readonly actorId: string;
  readonly actorIssuer: string;
  readonly actorSubject: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly target: NativeAdminTarget;
  readonly gatewayBase: string;
}

interface NativeAdminProxyDenial {
  readonly denied: true;
  readonly reason: NativeAdminWebSocketCloseReason;
  readonly actorId?: string;
  readonly actorIssuer?: string;
  readonly actorSubject?: string;
  readonly namespaceId?: string;
  readonly agentId?: string;
  readonly revisionId?: string;
  readonly host?: string;
  readonly actualAuthorizationDenied?: true;
  readonly evidence?: AuthorizationEvidence;
  readonly authorization?: NonNullable<AuthorizationDeniedError["authorization"]>;
}

type NativeAdminProxyAdmission = NativeAdminProxyResolution | NativeAdminProxyDenial;

interface RequiredPermission {
  readonly action: PermissionAction;
  readonly resourceKind: ResourceKind;
  readonly scope: "requested" | "installation" | "namespace" | "each_returned" | "request_body";
  readonly condition?:
    | "associated_service_account"
    | "existing_namespace"
    | "bound_secret"
    | "iam_binding_target"
    | "provisioning_work";
}

interface DocumentedFastifySchema extends FastifySchema {
  readonly "x-openclaw-permissions": readonly RequiredPermission[];
}

const resourceHandlers: ResourceHandlers = {
  ...configurationHandlers,
  ...presetHandlers,
  ...secretHandlers,
  ...iamHandlers,
  ...serviceAccountHandlers,
};

const DEFAULT_BODY_LIMIT = 64 * 1024;
// Four 16 KiB documents can expand sixfold in JSON, plus the ordinary create fields.
const AGENT_CREATE_BODY_LIMIT = 448 * 1024;
const WORKSPACE_FILE_BODY_LIMIT = 48 * 1024;
const WORKSPACE_FILE_CONTENT_LIMIT = 16 * 1024;
const NATIVE_ADMIN_PROXY_ADMISSION_TIMEOUT_MS = 5_000;
const NATIVE_ADMIN_CLOSE_AUDIT_DRAIN_MS = 5_000;
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const RESOURCE_ID = {
  namespaceId: /^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  presetId: /^pre_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  configurationId: /^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  serviceAccountId: /^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  secretId: /^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  agentId: /^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  revisionId: /^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
} as const;

function formatsPlugin(ajv: Parameters<typeof ajvFormats.default>[0]) {
  return ajvFormats.default(ajv);
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
      { path, code: "TOO_DEEP" },
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
        { path: `${path}/${jsonPointer(key)}`, code: "INVALID_VALUE" },
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
  if (secretId && namespaceId) {
    return { kind: "secret", id: secretId, namespaceId };
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

  if (operation.operationId === "createSecret" || operation.operationId === "listSecrets") {
    return [{ ...permission, scope: "namespace" }];
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
          ]
        : [
            {
              action: "read" as const,
              resourceKind: "configuration" as const,
              scope: "requested" as const,
            },
          ]),
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
    return [
      {
        action: permission.action,
        resourceKind: "agent",
        scope: "requested",
        condition: "provisioning_work",
      },
    ];
  }

  if (operation.operationId === "provisionAgentRuntimeCredentials") {
    return [
      { ...permission, scope: "requested" },
      { action: "read", resourceKind: "agent", scope: "requested" },
    ];
  }

  switch (operation.authorizationTarget) {
    case "namespace_collection":
      return [{ ...permission, scope: "namespace" }];
    case "preset_candidates":
    case "namespace_candidates":
      return [{ ...permission, scope: "each_returned" }];
    case "namespace_and_agent_candidates":
      return [
        { action: "read", resourceKind: "namespace", scope: "requested" },
        { ...permission, scope: "each_returned" },
      ];
    case "namespace_and_service_account_candidates":
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
  const names: Record<ResourceKind, string> = {
    installation: "Installation",
    namespace: "Namespace",
    configuration: "Configuration",
    preset: "Preset",
    service_account: "ServiceAccount",
    secret: "Secret",
    agent: "Agent",
    agent_revision: "AgentRevision",
  };

  const description = permissions
    .map(({ action, resourceKind, scope, condition }) => {
      const name = names[resourceKind];
      if (condition === "associated_service_account") {
        return `Requires ${action} permission on each currently associated or newly associated ${name} when present.`;
      }
      if (condition === "existing_namespace") {
        return `Requires ${action} permission on the ${name} when selecting an existing Kubernetes namespace.`;
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
      if (condition === "provisioning_work") {
        return `Requires current ${action} authorization for the accepted Agent provisioning record. Before Agent creation, only the initiating actor in the exact Namespace can use the work item.`;
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

function clientAgent(agent: Readonly<Agent>): Record<string, unknown> {
  return {
    id: agent.id,
    namespaceId: agent.namespaceId,
    name: agent.name,
    servicePrincipalId: agent.servicePrincipalId,
    configurationId: agent.configurationId,
    backendId: agent.backendId,
    executionMode: agent.executionMode,
    ...(agent.plugins === undefined ? {} : { plugins: agent.plugins }),
    ...(agent.repositoryBindings === undefined
      ? {}
      : { repositoryBindings: agent.repositoryBindings }),
    harnessAuth: agent.harnessAuth,
    ...(agent.activeRevisionId === undefined ? {} : { activeRevisionId: agent.activeRevisionId }),
    desiredRuntimeState: agent.desiredRuntimeState,
    status: agent.status,
    createdAt: agent.createdAt,
  };
}

function agentProvisioningUrl(namespaceId: string, workId: string): string {
  return `/namespaces/${encodeURIComponent(namespaceId)}/agents/provision/${encodeURIComponent(workId)}`;
}

function clientAgentProvisioning(
  provisioning: Readonly<AgentProvisioningProgress>,
  namespaceId: string,
): Record<string, unknown> {
  return {
    workId: provisioning.workId,
    status: provisioning.status,
    phase: provisioning.phase,
    attemptCount: provisioning.attemptCount,
    updatedAt: provisioning.updatedAt,
    ...(provisioning.agentId === undefined ? {} : { agentId: provisioning.agentId }),
    ...(provisioning.configurationId === undefined
      ? {}
      : { configurationId: provisioning.configurationId }),
    ...(provisioning.revisionId === undefined ? {} : { revisionId: provisioning.revisionId }),
    url: provisioning.url ?? agentProvisioningUrl(namespaceId, provisioning.workId),
    ...(provisioning.error === undefined ? {} : { error: provisioning.error }),
  };
}

function clientRevision(revision: Readonly<AgentRevision>): Record<string, unknown> {
  return {
    id: revision.id,
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    revision: revision.revision,
    configurationId: revision.configurationId,
    configurationKind: revision.configurationKind,
    configurationGeneration: revision.configurationGeneration,
    backendId: revision.backendId,
    configuration: revision.configuration,
    harness: revision.harness,
    compute: revision.compute,
    ...(revision.secretDriverId === undefined ? {} : { secretDriverId: revision.secretDriverId }),
    ...(revision.secretBindings === undefined ? {} : { secretBindings: revision.secretBindings }),
    ...(revision.plugins === undefined ? {} : { plugins: revision.plugins }),
    ...(revision.repositoryCredentials === undefined
      ? {}
      : {
          repositoryCredentials: {
            driver: revision.repositoryCredentials.driver,
            deadlineWallMs: revision.repositoryCredentials.deadlineWallMs,
            bindings: revision.repositoryCredentials.bindings.map(({ repositoryRef, profile }) => ({
              repositoryRef,
              profile,
            })),
          },
        }),
    harnessAuth: harnessAuthBindingFromSnapshot(revision.harnessAuth),
    createdAt: revision.createdAt,
  };
}

function clientDeploymentStatus(status: Readonly<DeploymentStatusResult>): Record<string, unknown> {
  return {
    deploymentId: status.deploymentId,
    namespaceId: status.namespaceId,
    agentId: status.agentId,
    status: status.status,
    error: status.error,
    warnings: status.warnings,
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
  const nativeAdminDomain = normalizeNativeAdminDomain(options.nativeAdmin?.domain);
  if (options.nativeAdmin?.enabled === true) {
    if (publicOrigin === undefined) {
      throw new Error("Native admin UI access requires OCC public origin configuration.");
    }
    if (new URL(publicOrigin).protocol !== "https:") {
      throw new Error("Native admin UI access requires an HTTPS public origin.");
    }
    if (nativeAdminDomain === undefined) {
      throw new Error("Native admin UI access requires an Agent domain.");
    }
    const sharedCookieDomain = options.auth.sharedCookieDomain;
    if (
      sharedCookieDomain === undefined ||
      normalizeSharedCookieDomain(options.nativeAdmin.sharedCookieDomain) !== sharedCookieDomain ||
      !hostnameMatchesSharedCookieDomain(new URL(publicOrigin).hostname, sharedCookieDomain)
    ) {
      throw new Error("Native admin UI access requires a shared cookie domain containing OCC.");
    }
    if (!hostnameMatchesSharedCookieDomain(nativeAdminDomain, sharedCookieDomain)) {
      throw new Error(
        "Native admin UI access requires an Agent domain inside the shared cookie domain.",
      );
    }
    if (options.nativeAdminGatewayApiKey === undefined) {
      throw new Error("Native admin UI access requires a private gateway API key.");
    }
  }
  validateTrustedDevelopmentCidrs(development);

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
    ajv: {
      customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false },
      plugins: [formatsPlugin],
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.removeContentTypeParser("text/plain");
  app.addSchema(JsonValue);
  app.addSchema(PluginDriverIdentitySchema);
  app.addSchema(PluginToolPolicySchema);
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
  const nativeAdminSockets = new Set<Socket>();
  const nativeAdminCloseAudits = new Set<Promise<void>>();
  let nativeAdminShuttingDown = false;
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
        required: ["email", "password", "roleId"],
        properties: {
          email: { type: "string", minLength: 3, maxLength: 320 },
          password: { type: "string", minLength: 12, maxLength: 128 },
          name: { type: "string", minLength: 1, maxLength: 200 },
          roleId: { type: "string", minLength: 1, maxLength: 200 },
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
  const nativeAdminStatusOperation = {
    operationId: "getAgentNativeAdmin",
    method: "GET",
    path: "/namespaces/:namespaceId/agents/:agentId/native-admin",
    action: "openclaw.agents.native_admin.read",
    iamAction: "administer",
    resourceKind: "agent",
    authorizationTarget: "agent",
    summary: "Resolve native admin UI launch availability for one Agent",
    tags: ["Agents"],
    schema: {},
  } as unknown as OccApiRoute;
  const nativeAdminParamsSchema = {
    type: "object",
    additionalProperties: false,
    required: ["namespaceId", "agentId"],
    properties: {
      namespaceId: { type: "string", minLength: 1, maxLength: 200 },
      agentId: { type: "string", minLength: 1, maxLength: 200 },
    },
  };
  const nativeAdminMetaSchema = {
    type: "object",
    additionalProperties: false,
    required: ["requestId"],
    properties: { requestId: { type: "string" } },
  };
  const nativeAdminErrorSchema = { $ref: "ErrorResponse#" };
  const nativeAdminStatusDataSchema = {
    type: "object",
    additionalProperties: false,
    required: ["status"],
    properties: {
      status: {
        type: "string",
        enum: ["available", "disabled", "stopped", "unavailable", "unsupported"],
      },
      host: { type: "string" },
      origin: { type: "string", format: "uri" },
      activeRevisionId: { type: "string" },
      url: { type: "string", format: "uri" },
    },
  };
  const nativeAdminStatusSchema = {
    operationId: nativeAdminStatusOperation.operationId,
    summary: nativeAdminStatusOperation.summary,
    description:
      "Requires a human session with administer permission on the exact Agent. Service API keys cannot launch or inspect native admin UI access.",
    tags: [...nativeAdminStatusOperation.tags],
    security: [{ sessionCookie: [] }],
    "x-openclaw-permissions": [{ action: "administer", resourceKind: "agent", scope: "requested" }],
    params: nativeAdminParamsSchema,
    response: {
      200: {
        description: "OK",
        type: "object",
        additionalProperties: false,
        required: ["data", "meta"],
        properties: { data: nativeAdminStatusDataSchema, meta: nativeAdminMetaSchema },
      },
      401: { description: "Unauthorized", ...nativeAdminErrorSchema },
      403: { description: "Forbidden", ...nativeAdminErrorSchema },
      404: { description: "Not Found", ...nativeAdminErrorSchema },
      503: { description: "Service Unavailable", ...nativeAdminErrorSchema },
    },
  } as DocumentedFastifySchema;
  function event(
    operation: OccApiRoute,
    request: FastifyRequest,
    resource: ResourceRef,
    kind: "bootstrap" | "mutation" | "authorization_denial",
    context?: RequestContext,
    evidence?: AuthorizationEvidence,
    result?: { readonly outcome: "success" | "denied" | "failure"; readonly reasonCode?: string },
    authorization?: NonNullable<AuthorizationDeniedError["authorization"]>,
  ): AuditEvent {
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
            iamDriverId: selectedIAMDriver().id,
            authorization: {
              principalId: context.actorId,
              action: authorization?.action ?? operation.iamAction,
              resource:
                authorization?.resource ??
                operationTarget(
                  operation,
                  installationId,
                  request.params as Record<string, unknown>,
                ),
            },
            ...(evidence === undefined
              ? {}
              : {
                  ...(evidence.restrictionIds.length > 0
                    ? { decisionReason: "A matching Restriction denied the operation." }
                    : {}),
                  details: {
                    iamEvidence: {
                      ...(evidence.identityId === undefined
                        ? {}
                        : { identityId: evidence.identityId }),
                      groupIds: evidence.groupIds,
                      bindingIds: evidence.bindingIds,
                      roleIds: evidence.roleIds,
                      restrictionIds: evidence.restrictionIds,
                    },
                  },
                }),
          }),
      action: operation.action,
      resource,
      outcome:
        result?.outcome ?? (kind === "bootstrap" || kind === "mutation" ? "success" : "denied"),
      ...(result?.reasonCode === undefined
        ? kind === "authorization_denial"
          ? { reasonCode: "AUTHORIZATION_DENIED" }
          : {}
        : { reasonCode: result.reasonCode }),
    });
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

  function dependencyUnavailable(): RequestFailure {
    return failure(503, "DEPENDENCY_UNAVAILABLE", "A required platform dependency is unavailable.");
  }

  function requireNativeAdminHumanSession(request: FastifyRequest, context: RequestContext) {
    const admitted = admissions.get(request);
    if (admitted?.method !== "session") {
      throw failure(403, "FORBIDDEN", "The exact platform operation was not authorized.");
    }
    const session = admitted.session;
    if (session.userId !== context.subject || Date.parse(session.expiresAt) <= Date.now()) {
      throw failure(401, "UNAUTHENTICATED", "The caller did not provide valid credentials.");
    }
    return session;
  }

  async function appendNativeAdminSocketAudit(
    eventName: "connect" | "close",
    resolution: NativeAdminProxyResolution,
    socketEvent: {
      readonly connectionId: string;
      readonly closeReason?: NativeAdminWebSocketCloseReason;
    },
  ): Promise<void> {
    await options.auditSink.append(
      factory.create({
        installationId,
        namespaceId: resolution.namespaceId,
        kind: "mutation",
        source: "occ",
        actor: {
          principalId: resolution.actorId,
          issuer: resolution.actorIssuer,
          subject: resolution.actorSubject,
        },
        iamDriverId: selectedIAMDriver().id,
        authorization: {
          principalId: resolution.actorId,
          action: "administer",
          resource: {
            kind: "agent",
            id: resolution.agentId,
            namespaceId: resolution.namespaceId,
          },
        },
        action: `openclaw.agents.native_admin.websocket.${eventName}`,
        resource: {
          kind: "agent",
          id: resolution.agentId,
          namespaceId: resolution.namespaceId,
        },
        outcome: "success",
        details: {
          nativeAdmin: {
            event: eventName,
            connectionId: socketEvent.connectionId,
            ...(socketEvent.closeReason === undefined
              ? {}
              : { closeReason: socketEvent.closeReason }),
            parentSessionId: resolution.parentSessionId,
            revisionId: resolution.revisionId,
            host: resolution.target.host,
          },
        },
      }),
    );
  }

  async function appendNativeAdminProxyDenialAudit(
    admission: NativeAdminProxyAdmission | undefined,
  ): Promise<void> {
    if (
      admission === undefined ||
      !("denied" in admission) ||
      admission.actualAuthorizationDenied !== true ||
      admission.authorization === undefined ||
      !isNonEmptyString(admission.actorId) ||
      !isNonEmptyString(admission.actorIssuer) ||
      !isNonEmptyString(admission.actorSubject) ||
      !isNonEmptyString(admission.namespaceId) ||
      !isNonEmptyString(admission.agentId)
    ) {
      return;
    }
    await options.auditSink.append(
      factory.create({
        installationId,
        namespaceId: admission.namespaceId,
        kind: "authorization_denial",
        source: "occ",
        actor: {
          principalId: admission.actorId,
          issuer: admission.actorIssuer,
          subject: admission.actorSubject,
        },
        iamDriverId: selectedIAMDriver().id,
        authorization: { principalId: admission.actorId, ...admission.authorization },
        action: "openclaw.agents.native_admin.proxy.authorize",
        resource: {
          kind: "agent",
          id: admission.agentId,
          namespaceId: admission.namespaceId,
        },
        outcome: "denied",
        reasonCode: admission.reason.toUpperCase(),
        ...(admission.evidence?.restrictionIds.length
          ? { decisionReason: "A matching Restriction denied the operation." }
          : {}),
        details: {
          nativeAdmin: {
            reason: admission.reason,
            ...(isNonEmptyString(admission.revisionId) ? { revisionId: admission.revisionId } : {}),
            ...(isNonEmptyString(admission.host) ? { host: admission.host } : {}),
          },
          ...(admission.evidence === undefined
            ? {}
            : {
                iamEvidence: {
                  ...(admission.evidence.identityId === undefined
                    ? {}
                    : { identityId: admission.evidence.identityId }),
                  groupIds: admission.evidence.groupIds,
                  bindingIds: admission.evidence.bindingIds,
                  roleIds: admission.evidence.roleIds,
                  restrictionIds: admission.evidence.restrictionIds,
                },
              }),
        },
      }),
    );
  }

  function nativeAdminAuthority(
    hostHeader: string | readonly string[] | undefined,
  ): string | undefined {
    if (Array.isArray(hostHeader) || !isNonEmptyString(hostHeader)) {
      return undefined;
    }
    const raw = hostHeader.trim();
    if (raw !== hostHeader) {
      return undefined;
    }
    const trimmed = raw.toLowerCase();
    if (
      trimmed.includes("/") ||
      trimmed.includes("\\") ||
      trimmed.includes("@") ||
      trimmed.includes("?") ||
      trimmed.includes("#")
    ) {
      return undefined;
    }
    try {
      const parsed = new URL(`https://${trimmed}`);
      if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.pathname !== "/") {
        return undefined;
      }
      return parsed.host;
    } catch {
      return undefined;
    }
  }

  function nativeAdminHostname(
    hostHeader: string | readonly string[] | undefined,
  ): string | undefined {
    const authority = nativeAdminAuthority(hostHeader);
    if (authority === undefined) {
      return undefined;
    }
    return new URL(`https://${authority}`).hostname.toLowerCase();
  }

  function publicOriginHostname(): string | undefined {
    if (publicOrigin === undefined) {
      return undefined;
    }
    try {
      return new URL(publicOrigin).hostname.toLowerCase();
    } catch {
      return undefined;
    }
  }

  function isNativeAdminDomainHost(hostname: string | undefined): hostname is string {
    if (hostname === undefined || nativeAdminDomain === undefined) {
      return false;
    }
    return hostname !== publicOriginHostname() && hostname.endsWith(`.${nativeAdminDomain}`);
  }

  function isNativeAdminAgentHost(hostname: string | undefined): hostname is string {
    return isNativeAdminDomainHost(hostname) && hostname.startsWith("agent-");
  }

  function nativeAdminPathname(url: string | undefined): string {
    return url?.split("?", 1)[0] || "/";
  }

  function isNativeAdminReservedPrefix(url: string | undefined): boolean {
    return nativeAdminPathname(url).startsWith("/__occ/native-admin/");
  }

  async function boundedNativeAdminAdmission<T>(operation: Promise<T>): Promise<T | undefined> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<undefined>((resolve) => {
          const timer = setTimeout(
            () => resolve(undefined),
            NATIVE_ADMIN_PROXY_ADMISSION_TIMEOUT_MS,
          );
          timeout = timer;
          timer.unref();
        }),
      ]);
    } catch {
      return undefined;
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  async function drainNativeAdminCloseAudits(): Promise<void> {
    if (nativeAdminCloseAudits.size === 0) {
      return;
    }
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...nativeAdminCloseAudits]),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, NATIVE_ADMIN_CLOSE_AUDIT_DRAIN_MS);
          timeout = timer;
          timer.unref();
        }),
      ]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  async function nativeAdminProxyTransportContext(
    resolution: NativeAdminProxyResolution | undefined,
  ): Promise<NativeAdminProxyContext | undefined> {
    if (resolution === undefined || options.nativeAdminGatewayApiKey === undefined) {
      return undefined;
    }
    try {
      const apiKey = await options.nativeAdminGatewayApiKey();
      if (!isNonEmptyString(apiKey)) {
        return undefined;
      }
      return {
        gatewayBase: resolution.gatewayBase,
        agentOrigin: resolution.target.origin,
        apiKey,
      };
    } catch {
      return undefined;
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
          undefined,
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

  app.addHook("onRequest", async (request, reply) => {
    requestStartedAt.set(request, process.hrtime.bigint());
    responseHeaders(reply, request.id);
    if (await interceptNativeAdminHttp(request, reply)) {
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
    if (Object.keys(request.query as Record<string, unknown>).length > 0) {
      throw failure(400, "INVALID_REQUEST", "The request does not match the operation contract.");
    }
    for (const [parameter, pattern] of Object.entries(RESOURCE_ID)) {
      if (
        params[parameter] !== undefined &&
        (typeof params[parameter] !== "string" || !pattern.test(params[parameter] as string))
      ) {
        throw failure(400, "INVALID_REQUEST", "The request does not match the operation contract.");
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
    const forwarded = Object.keys(request.headers).some(
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
      admitted = await options.auth.admissionVerifier.verify({
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
        accessToken: body?.accessToken as string,
        ...(body?.cursor === undefined ? {} : { cursor: body.cursor as string }),
      });
      reply.header("cache-control", "no-store");
      reply.send({ data: catalog, meta: { requestId: request.id } });
      return;
    }

    if (operation.operationId === "discoverAgentPluginDetails") {
      const plugin = await controller.discoverAgentPluginDetails(context.actorId, namespaceId, {
        accessToken: body?.accessToken as string,
        pluginId: body?.pluginId as string,
      });
      reply.header("cache-control", "no-store");
      reply.send({ data: plugin, meta: { requestId: request.id } });
      return;
    }

    const resourceHandler = resourceHandlers[operation.operationId];
    if (resourceHandler) {
      await resourceHandler({
        controller,
        context,
        request,
        reply,
        params,
        body,
        namespaceId,
        mutationEvent: (resource) => event(operation, request, resource, "mutation", context),
      });
      return;
    }

    if (operation.operationId === "provisionAgent") {
      const provisionBody = body as unknown as ProvisionAgentBody;
      try {
        normalizeInitialWorkspaceFiles(provisionBody.initialWorkspaceFiles);
      } catch {
        throw failure(
          400,
          "INVALID_REQUEST",
          "Initial workspace files must use the four allowed names and valid Unicode without NUL, within 16 KiB per file.",
        );
      }
      if (
        provisionBody.workspaceDefaultsId !== undefined &&
        provisionBody.workspaceDefaultsId !== WORKSPACE_DEFAULTS_ID
      ) {
        throw failure(
          409,
          "RESOURCE_CONFLICT",
          "Workspace defaults changed. Reload the create form before submitting.",
        );
      }
      const result = await controller.transact(async (unit) => {
        const provisioned = await controller!.provisionAgent(context.actorId, {
          requestId: provisionBody.requestId,
          namespaceId,
          name: provisionBody.name,
          configuration: provisionBody.configuration as ProvisionAgentInput["configuration"],
          ...(provisionBody.initialWorkspaceFiles === undefined
            ? {}
            : {
                initialWorkspaceFiles: provisionBody.initialWorkspaceFiles as InitialWorkspaceFiles,
              }),
          ...(provisionBody.workspaceDefaultsId === undefined
            ? {}
            : { workspaceDefaultsId: provisionBody.workspaceDefaultsId }),
          ...(provisionBody.backendId === undefined ? {} : { backendId: provisionBody.backendId }),
          ...(provisionBody.executionMode === undefined
            ? {}
            : { executionMode: provisionBody.executionMode as HarnessExecutionMode }),
          ...(provisionBody.harnessAuth === undefined
            ? {}
            : {
                harnessAuth: provisionBody.harnessAuth as NonNullable<
                  ProvisionAgentInput["harnessAuth"]
                >,
              }),
          ...(provisionBody.plugins === undefined
            ? {}
            : { plugins: provisionBody.plugins as never }),
          ...(provisionBody.repositoryBindings === undefined
            ? {}
            : {
                repositoryBindings:
                  provisionBody.repositoryBindings as readonly RepositoryBindingRequest[],
              }),
        });
        await unit.audit.append(
          event(
            operation,
            request,
            {
              kind: "agent",
              id: provisioned.provisioning.agentId ?? provisioned.provisioning.workId,
              namespaceId,
            },
            "mutation",
            context,
          ),
        );
        return {
          provisioning: clientAgentProvisioning(provisioned.provisioning, namespaceId),
        };
      });
      reply.status(202).send({ data: result, meta: { requestId: request.id } });
      return;
    }

    if (operation.operationId === "listRepositoryOptions") {
      const options = await controller!
        .listRepositoryOptions(context.actorId, namespaceId)
        .catch((error: unknown) => {
          if (error instanceof RepositoryOptionsUnavailableError) {
            throw failure(
              503,
              "REPOSITORY_OPTIONS_UNAVAILABLE",
              "Repository options are unavailable.",
            );
          }
          throw error;
        });
      reply.send({
        data: options.map(({ repositoryRef, displayName, allowedProfiles }) => ({
          repositoryRef,
          displayName,
          allowedProfiles,
        })),
        meta: { requestId: request.id },
      });
      return;
    }

    if (operation.operationId === "createAgent") {
      try {
        normalizeInitialWorkspaceFiles(body?.initialWorkspaceFiles);
      } catch {
        throw failure(
          400,
          "INVALID_REQUEST",
          "Initial workspace files must use the four allowed names and valid Unicode without NUL, within 16 KiB per file.",
        );
      }
      if (
        body?.workspaceDefaultsId !== undefined &&
        body.workspaceDefaultsId !== WORKSPACE_DEFAULTS_ID
      ) {
        throw failure(
          409,
          "RESOURCE_CONFLICT",
          "Workspace defaults changed. Reload the create form before submitting.",
        );
      }
      const agent = await controller.transact(async (unit) => {
        const created = await controller!.createAgent(context.actorId, {
          namespaceId,
          ...(body?.initialWorkspaceFiles === undefined
            ? {}
            : { initialWorkspaceFiles: body.initialWorkspaceFiles as InitialWorkspaceFiles }),
          ...(body?.workspaceDefaultsId === undefined
            ? {}
            : { workspaceDefaultsId: body.workspaceDefaultsId as string }),
          name: body?.name as string,
          configurationId: body?.configurationId as string,
          ...(body?.backendId === undefined ? {} : { backendId: body.backendId as string | null }),
          ...(body?.executionMode === undefined
            ? {}
            : { executionMode: body.executionMode as HarnessExecutionMode }),
          ...(body?.harnessAuth === undefined
            ? {}
            : { harnessAuth: body.harnessAuth as HarnessAuthBinding | null }),
          ...(body?.plugins === undefined ? {} : { plugins: body.plugins as never }),
          ...(body?.repositoryBindings === undefined
            ? {}
            : {
                repositoryBindings: body.repositoryBindings as readonly RepositoryBindingRequest[],
              }),
        });
        await unit.audit.append(
          event(
            operation,
            request,
            { kind: "agent", id: created.id, namespaceId },
            "mutation",
            context,
          ),
        );
        return clientAgent(created);
      });
      reply.status(201).send({ data: agent, meta: { requestId: request.id } });
      return;
    }

    if (operation.operationId === "listAgents") {
      const agents = await controller.listAgents(context.actorId, namespaceId);
      reply.send({ data: agents.map(clientAgent), meta: { requestId: request.id } });
      return;
    }

    if (operation.operationId === "getAgentProvisioning") {
      const workId = params.workId;
      if (!workId) {
        throw failure(400, "INVALID_REQUEST", "The request does not match the operation contract.");
      }
      const provisioned = await controller.getAgentProvisioning(
        context.actorId,
        namespaceId,
        workId,
      );
      reply.send({
        data: clientAgentProvisioning(provisioned.provisioning, namespaceId),
        meta: { requestId: request.id },
      });
      return;
    }

    if (operation.operationId === "retryAgentProvisioning") {
      const workId = params.workId;
      if (!workId) {
        throw failure(400, "INVALID_REQUEST", "The request does not match the operation contract.");
      }
      const provisioning = await controller.transact(async (unit) => {
        const retried = await controller!.retryAgentProvisioning(
          context.actorId,
          namespaceId,
          workId,
        );
        await unit.audit.append(
          event(
            operation,
            request,
            {
              kind: "agent",
              id: retried.provisioning.agentId ?? retried.provisioning.workId,
              namespaceId,
            },
            "mutation",
            context,
          ),
        );
        return retried.provisioning;
      });
      reply.status(202).send({
        data: clientAgentProvisioning(provisioning, namespaceId),
        meta: { requestId: request.id },
      });
      return;
    }

    const agentId = params.agentId;
    if (!agentId) {
      throw failure(400, "INVALID_REQUEST", "The request does not match the operation contract.");
    }
    if (operation.operationId === "getAgent") {
      reply.send({
        data: clientAgent(await controller.getAgent(context.actorId, namespaceId, agentId)),
        meta: { requestId: request.id },
      });
      return;
    }

    if (operation.operationId === "updateAgent") {
      const agent = await controller.transact(async (unit) => {
        const updated = await controller!.updateAgent(context.actorId, {
          namespaceId,
          agentId,
          configurationId: body?.configurationId as string,
          ...(body?.backendId === undefined ? {} : { backendId: body.backendId as string | null }),
          ...(body?.executionMode === undefined
            ? {}
            : { executionMode: body.executionMode as HarnessExecutionMode }),
          ...(body?.harnessAuth === undefined
            ? {}
            : { harnessAuth: body.harnessAuth as HarnessAuthBinding | null }),
          ...(body?.plugins === undefined ? {} : { plugins: body.plugins as never }),
          ...(body?.repositoryBindings === undefined
            ? {}
            : {
                repositoryBindings: body.repositoryBindings as readonly RepositoryBindingRequest[],
              }),
        });
        await unit.audit.append(
          event(
            operation,
            request,
            { kind: "agent", id: updated.id, namespaceId },
            "mutation",
            context,
          ),
        );
        return clientAgent(updated);
      });
      reply.send({ data: agent, meta: { requestId: request.id } });
      return;
    }

    if (operation.operationId === "deleteAgent") {
      const agent = await controller.transact(async (unit) => {
        const deleting = await controller!.deleteAgent(context.actorId, namespaceId, agentId);
        await unit.audit.append(
          event(
            operation,
            request,
            { kind: "agent", id: deleting.id, namespaceId },
            "mutation",
            context,
          ),
        );
        return clientAgent(deleting);
      });
      reply.status(202).send({ data: agent, meta: { requestId: request.id } });
      return;
    }

    if (operation.operationId === "getAgentRuntimeImages") {
      const images = await controller.getAgentRuntimeImages(context.actorId, namespaceId, agentId);
      reply.send({ data: images, meta: { requestId: request.id } });
      return;
    }

    if (operation.operationId === "getAgentRuntimeCredentials") {
      const status = await controller.getAgentRuntimeCredentialStatus(
        context.actorId,
        namespaceId,
        agentId,
      );
      reply.send({ data: status, meta: { requestId: request.id } });
      return;
    }

    if (operation.operationId === "provisionAgentRuntimeCredentials") {
      requireWorkspaceFileCsrf(request, true);
      const status = await controller.transact(async (unit) => {
        const provisioned = await controller!.provisionAgentRuntimeCredentials(
          context.actorId,
          namespaceId,
          agentId,
          body as unknown as AgentRuntimeCredentialsBody,
        );
        try {
          await unit.audit.append(
            event(
              operation,
              request,
              { kind: "agent", id: agentId, namespaceId },
              "mutation",
              context,
            ),
          );
        } catch {
          throw dependencyUnavailable();
        }
        return provisioned;
      });
      reply.send({ data: status, meta: { requestId: request.id } });
      return;
    }

    if (operation.operationId === "deployAgent") {
      try {
        const revision = await controller.transact(async (unit) => {
          const admitted = await controller!.deployAgent(
            context.actorId,
            { namespaceId, agentId },
            options.resolveHarness,
          );
          await unit.audit.append(
            event(
              operation,
              request,
              { kind: "agent_revision", id: admitted.id, namespaceId },
              "mutation",
              context,
            ),
          );
          return clientRevision(admitted);
        });
        reply.status(202).send({ data: revision, meta: { requestId: request.id } });
        return;
      } catch (error) {
        if (error instanceof NamespaceNotReadyError) {
          await rejectedMutation(operation, request, context, "NAMESPACE_NOT_READY");
        }
        throw error;
      }
    }

    if (operation.operationId === "stopAgent") {
      const stopped = await controller.transact(async (unit) => {
        const agent = await controller!.stopAgent(context.actorId, namespaceId, agentId);
        try {
          await unit.audit.append(
            event(
              operation,
              request,
              { kind: "agent", id: agentId, namespaceId },
              "mutation",
              context,
            ),
          );
        } catch {
          throw dependencyUnavailable();
        }
        return clientAgent(agent);
      });
      reply.status(202).send({ data: stopped, meta: { requestId: request.id } });
      return;
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

    if (operation.operationId === "listAgentRevisions") {
      const revisions = await controller.listRevisions(context.actorId, namespaceId, agentId);
      reply.send({
        data: revisions.map(clientRevision),
        meta: { requestId: request.id },
      });
      return;
    }

    if (operation.operationId === "getAgentRevision") {
      const revision = await controller.getRevision(
        context.actorId,
        namespaceId,
        agentId,
        params.revisionId as string,
      );
      reply.send({ data: clientRevision(revision), meta: { requestId: request.id } });
      return;
    }

    if (operation.operationId === "getAgentDeployment") {
      const status = await controller.getDeploymentStatus(
        context.actorId,
        namespaceId,
        agentId,
        params.deploymentId as string,
      );
      reply.send({ data: clientDeploymentStatus(status), meta: { requestId: request.id } });
      return;
    }

    throw failure(404, "NOT_FOUND", "The requested platform resource was not found.");
  }

  type NativeAdminTargetStatus = {
    readonly agent: Agent;
    readonly revision: AgentRevision;
    readonly target: NativeAdminTarget;
  };
  type NativeAdminAvailability =
    | { readonly status: "disabled" | "stopped" | "unavailable" }
    | ({ readonly status: "stopped" | "unsupported" } & NativeAdminTargetStatus)
    | ({ readonly status: "available"; readonly gatewayBase: string } & NativeAdminTargetStatus);

  async function resolveNativeAdminAvailability(input: {
    readonly actorId: string;
    readonly namespaceId: string;
    readonly agentId: string;
  }): Promise<NativeAdminAvailability> {
    if (!controller) {
      throw failure(404, "NOT_FOUND", "The requested platform resource was not found.");
    }
    if (options.nativeAdmin?.enabled !== true) {
      await controller.getAdministerableAgent(input.actorId, input.namespaceId, input.agentId);
      return { status: "disabled" };
    }
    if (publicOrigin === undefined || nativeAdminDomain === undefined) {
      throw dependencyUnavailable();
    }
    let selection;
    try {
      selection = await controller.getAdministerableActiveAgentRevision(
        input.actorId,
        input.namespaceId,
        input.agentId,
      );
    } catch (error) {
      // This administering lookup conflicts only when the authorized Agent is stopped without an active revision.
      if (error instanceof ResourceConflictError) {
        return { status: "stopped" };
      }
      if (isDependencyUnavailable(error)) {
        return { status: "unavailable" };
      }
      throw error;
    }
    const { agent, revision } = selection;
    const target = nativeAdminTarget({
      publicOrigin,
      installationId,
      agent,
      revision,
      domain: nativeAdminDomain,
    });
    if (agent.desiredRuntimeState !== "running") {
      return { status: "stopped", agent, revision, target };
    }
    if (!nativeAdminConfigurationSupported(revision, target.origin)) {
      return { status: "unsupported", agent, revision, target };
    }
    let compute: ComputeDriver;
    try {
      compute = controller.selectedDriver("compute");
    } catch {
      throw dependencyUnavailable();
    }
    const gatewayBase = nativeAdminGatewayHttpBase(compute.getGatewayEndpoint?.(revision) ?? "");
    if (gatewayBase === undefined) {
      return { status: "unsupported", agent, revision, target };
    }
    return { status: "available", agent, revision, target, gatewayBase };
  }

  async function resolveNativeAdminAgentHost(
    hostname: string,
  ): Promise<Pick<Agent, "id" | "namespaceId"> | undefined> {
    const domain = nativeAdminDomain;
    if (!controller || domain === undefined) {
      return undefined;
    }
    return controller.resolveAgentReference(
      (agent) => deriveNativeAdminHost(installationId, agent, domain) === hostname,
    );
  }

  function nativeAdminAvailabilityData(availability: NativeAdminAvailability) {
    if (!("target" in availability)) {
      return { status: availability.status };
    }
    return {
      status: availability.status,
      host: availability.target.host,
      origin: availability.target.origin,
      activeRevisionId: availability.revision.id,
      url: availability.target.url,
    };
  }

  async function requireAvailableNativeAdminTarget(input: {
    readonly actorId: string;
    readonly namespaceId: string;
    readonly agentId: string;
    readonly expectedHost?: string;
    readonly expectedRevisionId?: string;
  }) {
    if (!controller) {
      throw failure(403, "FORBIDDEN", "The exact platform operation was not authorized.");
    }
    const availability = await resolveNativeAdminAvailability(input);
    if (availability.status === "disabled") {
      throw failure(403, "FORBIDDEN", "The exact platform operation was not authorized.");
    }
    if (
      availability.status === "unsupported" &&
      input.expectedRevisionId !== undefined &&
      availability.revision.id !== input.expectedRevisionId
    ) {
      throw failure(409, "RESOURCE_CONFLICT", "The active AgentRevision changed.");
    }
    if (availability.status !== "available") {
      throw dependencyUnavailable();
    }
    if (
      input.expectedRevisionId !== undefined &&
      availability.revision.id !== input.expectedRevisionId
    ) {
      throw failure(409, "RESOURCE_CONFLICT", "The active AgentRevision changed.");
    }
    if (input.expectedHost !== undefined && availability.target.host !== input.expectedHost) {
      throw failure(403, "FORBIDDEN", "The exact platform operation was not authorized.");
    }
    return availability;
  }

  async function getNativeAdminStatus(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const context = contexts.get(request);
    if (!context) {
      throw dependencyUnavailable();
    }
    const params = request.params as Record<string, string | undefined>;
    const namespaceId = params.namespaceId;
    const agentId = params.agentId;
    if (!isNonEmptyString(namespaceId) || !isNonEmptyString(agentId)) {
      throw failure(400, "INVALID_REQUEST", "The request does not match the operation contract.");
    }
    requireNativeAdminHumanSession(request, context);
    const availability = await resolveNativeAdminAvailability({
      actorId: context.actorId,
      namespaceId,
      agentId,
    });
    reply.send({
      data: nativeAdminAvailabilityData(availability),
      meta: { requestId: request.id },
    });
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
          properties: { code: { type: "string" }, message: { type: "string" } },
        },
        meta,
      },
    };
    const responses = (success: Record<string, unknown>, status = 200) => ({
      [status]: { description: status === 201 ? "Created" : "OK", ...envelope(success) },
      401: { description: "Unauthorized", ...error },
      503: { description: "Service Unavailable", ...error },
    });
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
            ? "Requires a session or Installation-scoped service key with administer on the Installation. Issues a Better Auth key for an existing non-Agent ServicePrincipal in its exact scope; creates no identity or IAM grant. The plaintext key is returned only here."
            : "Requires a session or Installation-scoped service key with administer on the Installation. Deletes the stored Better Auth key; subsequent requests cannot authenticate with it.",
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
            throw failure(
              400,
              "INVALID_REQUEST",
              "The request does not match the operation contract.",
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

    routes.post(
      "/api/auth/sign-in/email",
      {
        schema: {
          operationId: "signInEmail",
          summary: "Sign in with email and password",
          description: "Authenticates a local account and issues a user session cookie.",
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
          response: responses({
            type: "object",
            additionalProperties: false,
            required: ["authenticated"],
            properties: { authenticated: { type: "boolean", const: true } },
          }),
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
          response: responses({ type: "object", additionalProperties: true }),
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
            "Returns only authenticated status and public account identity, or null without a valid session; session tokens and credentials are never returned.",
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
                    required: ["authenticated", "user"],
                    properties: {
                      authenticated: { type: "boolean", const: true },
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
            "Requires administer permission on the Installation. Creates a Better Auth account, an explicit IAM Principal, and a binding to the requested existing IAM Role; public signup remains disabled.",
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
        if (
          !isNonEmptyString(email) ||
          !isNonEmptyString(password) ||
          !isNonEmptyString(roleId) ||
          (name !== undefined && !isNonEmptyString(name))
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

        const account = await options.auth.createAccount({
          email,
          password,
          ...(name === undefined ? {} : { name }),
        });
        const seed = options.auth.principalSeed(account, { roleId });
        const auditEvent = event(
          createAuthAccountOperation,
          request,
          target,
          "mutation",
          context,
          decision.evidence,
        );
        try {
          await options.provisionAuthAccount(seed, auditEvent);
        } catch (error) {
          try {
            await options.auth.deleteAccount(account);
          } catch {
            // The failed provisioning path still returns the original dependency error.
          }
          throw error instanceof RequestFailure
            ? error
            : error instanceof AuthAccountRoleNotFoundError
              ? failure(
                  400,
                  "INVALID_REQUEST",
                  "The request does not match the operation contract.",
                )
              : new DependencyUnavailableError(
                  error instanceof Error ? error.message : "Auth account provisioning failed.",
                );
        }
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
    routes.addSchema(AgentRuntimeCredentialResponse);
    routes.addSchema(SecretResponse);
    routes.route({
      method: "GET",
      url: nativeAdminStatusOperation.path,
      schema: nativeAdminStatusSchema,
      onRequest: async (request) => admit(request, nativeAdminStatusOperation),
      preHandler: async (request) => resolveIdentity(request, nativeAdminStatusOperation),
      handler: getNativeAdminStatus,
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
              "The request does not match the operation contract.",
            );
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

  app.server.on("upgrade", (request, socket, head) => {
    void handleNativeAdminUpgrade(request, socket as Socket, head);
  });

  app.addHook("preClose", async () => {
    nativeAdminShuttingDown = true;
    await Promise.all(
      [...nativeAdminSockets].map(
        (socket) =>
          new Promise<void>((resolve) => {
            socket.once("close", () => resolve());
            socket.destroy();
          }),
      ),
    );
    nativeAdminSockets.clear();
    await drainNativeAdminCloseAudits();
  });

  async function resolveNativeAdminActor(input: {
    readonly actorIssuer: string;
    readonly actorSubject: string;
  }): Promise<string | undefined> {
    try {
      const identity = await selectedIAMDriver().lookupIdentity({
        issuer: input.actorIssuer,
        subject: input.actorSubject,
      });
      if (
        identity?.kind !== "principal" ||
        identity.issuer !== input.actorIssuer ||
        identity.subject !== input.actorSubject
      ) {
        return undefined;
      }
      return identity.id;
    } catch {
      return undefined;
    }
  }

  function nativeAdminProxyDenial(
    reason: NativeAdminWebSocketCloseReason,
    input: Omit<NativeAdminProxyDenial, "denied" | "reason"> = {},
  ): NativeAdminProxyDenial {
    return { denied: true, reason, ...input };
  }

  function isNativeAdminProxyResolution(
    admission: NativeAdminProxyAdmission | undefined,
  ): admission is NativeAdminProxyResolution {
    return admission !== undefined && !("denied" in admission);
  }

  function nativeAdminFailureReason(error: unknown): NativeAdminWebSocketCloseReason {
    const mapped = requestFailure(error);
    if (mapped.code === "RESOURCE_CONFLICT") {
      return "revision_changed";
    }
    if (mapped.code === "DEPENDENCY_UNAVAILABLE") {
      return "agent_unavailable";
    }
    if (mapped.code === "FORBIDDEN") {
      return options.nativeAdmin?.enabled === true ? "authorization_denied" : "disabled";
    }
    return "dependency_failure";
  }

  async function nativeAdminProxyContext(
    request: IncomingMessage,
    hostname: string,
    expectedRevisionId?: string,
  ): Promise<NativeAdminProxyAdmission> {
    let admitted: AdmittedCaller;
    try {
      admitted = await options.auth.admissionVerifier.verify({
        requestId: `nar_${randomUUID()}`,
        method: request.method ?? "GET",
        routeId: "nativeAdminProxy",
        requestedScope: { installationId },
        transport: {
          remoteAddress: request.socket.remoteAddress ?? "127.0.0.1",
          ...(request.socket.localAddress === undefined
            ? {}
            : { localAddress: request.socket.localAddress }),
          trustProxy: false,
        },
        ...(typeof request.headers.authorization === "string"
          ? { authorizationHeader: request.headers.authorization }
          : {}),
        headers: request.headers,
      });
    } catch {
      return nativeAdminProxyDenial("session_invalid");
    }
    if (
      admitted.method !== "session" ||
      admitted.admittedScope.installationId !== installationId ||
      !isNonEmptyString(admitted.externalIdentity.issuer) ||
      !isNonEmptyString(admitted.externalIdentity.subject)
    ) {
      return nativeAdminProxyDenial("session_invalid");
    }
    const session = admitted.session;
    if (
      session.userId !== admitted.externalIdentity.subject ||
      Date.parse(session.expiresAt) <= Date.now()
    ) {
      return nativeAdminProxyDenial("session_invalid");
    }
    const actorIssuer = admitted.externalIdentity.issuer;
    const actorSubject = admitted.externalIdentity.subject;
    const currentActor = await resolveNativeAdminActor({ actorIssuer, actorSubject });
    if (currentActor === undefined) {
      return nativeAdminProxyDenial("authorization_denied");
    }
    const agent = await resolveNativeAdminAgentHost(hostname);
    if (agent === undefined) {
      return nativeAdminProxyDenial("authorization_denied");
    }
    try {
      const resolved = await requireAvailableNativeAdminTarget({
        actorId: currentActor,
        namespaceId: agent.namespaceId,
        agentId: agent.id,
        expectedHost: hostname,
        ...(expectedRevisionId === undefined ? {} : { expectedRevisionId }),
      });
      const requestAuthority = nativeAdminAuthority(request.headers.host);
      if (requestAuthority !== new URL(resolved.target.origin).host.toLowerCase()) {
        return nativeAdminProxyDenial("session_invalid");
      }
      return {
        parentSessionId: session.id,
        actorId: currentActor,
        actorIssuer,
        actorSubject,
        namespaceId: resolved.agent.namespaceId,
        agentId: resolved.agent.id,
        revisionId: resolved.revision.id,
        target: resolved.target,
        gatewayBase: resolved.gatewayBase,
      };
    } catch (error) {
      if (isAuthorizationDenied(error)) {
        return nativeAdminProxyDenial("authorization_denied", {
          actorId: currentActor,
          actorIssuer,
          actorSubject,
          namespaceId: agent.namespaceId,
          agentId: agent.id,
          ...(expectedRevisionId === undefined ? {} : { revisionId: expectedRevisionId }),
          host: hostname,
          actualAuthorizationDenied: true,
          ...(error.evidence === undefined ? {} : { evidence: error.evidence }),
          ...(error.authorization === undefined ? {} : { authorization: error.authorization }),
        });
      }
      return nativeAdminProxyDenial(nativeAdminFailureReason(error));
    }
  }

  async function interceptNativeAdminHttp(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<boolean> {
    const hostname = nativeAdminHostname(request.headers.host);
    if (!isNativeAdminDomainHost(hostname)) {
      return false;
    }
    if (isNativeAdminReservedPrefix(request.url) || !isNativeAdminAgentHost(hostname)) {
      canonicalFailure(
        reply,
        failure(403, "FORBIDDEN", "The exact platform operation was not authorized."),
      );
      return true;
    }
    const admission = await boundedNativeAdminAdmission(
      nativeAdminProxyContext(request.raw, hostname),
    );
    if (!isNativeAdminProxyResolution(admission)) {
      try {
        await appendNativeAdminProxyDenialAudit(admission);
      } catch {
        canonicalFailure(reply, dependencyUnavailable());
        return true;
      }
      canonicalFailure(
        reply,
        admission === undefined
          ? dependencyUnavailable()
          : failure(403, "FORBIDDEN", "The exact platform operation was not authorized."),
      );
      return true;
    }
    const context = await boundedNativeAdminAdmission(nativeAdminProxyTransportContext(admission));
    if (context === undefined) {
      canonicalFailure(reply, dependencyUnavailable());
      return true;
    }
    await streamNativeAdminHttp({ request, reply, context });
    return true;
  }

  async function handleNativeAdminUpgrade(
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): Promise<void> {
    const hostname = nativeAdminHostname(request.headers.host);
    if (!isNativeAdminAgentHost(hostname) || isNativeAdminReservedPrefix(request.url)) {
      socket.destroy();
      return;
    }
    nativeAdminSockets.add(socket);
    socket.once("close", () => nativeAdminSockets.delete(socket));
    const admission = await boundedNativeAdminAdmission(nativeAdminProxyContext(request, hostname));
    if (!isNativeAdminProxyResolution(admission)) {
      try {
        await appendNativeAdminProxyDenialAudit(admission);
      } catch {
        app.log.warn({ event: "native_admin.websocket_denial_audit_failed" });
      }
      socket.destroy();
      return;
    }
    const context = await boundedNativeAdminAdmission(nativeAdminProxyTransportContext(admission));
    if (context === undefined) {
      socket.destroy();
      return;
    }
    const connectionId = `naws_${randomUUID()}`;
    proxyNativeAdminWebSocket({
      request,
      socket,
      head,
      context,
      connectionId,
      lease: async () => {
        const renewed = await boundedNativeAdminAdmission(
          nativeAdminProxyContext(request, hostname, admission.revisionId),
        );
        if (renewed === undefined) {
          return "dependency_timeout";
        }
        if (!isNativeAdminProxyResolution(renewed)) {
          try {
            await appendNativeAdminProxyDenialAudit(renewed);
          } catch {
            return "dependency_failure";
          }
          return renewed.reason;
        }
        return undefined;
      },
      onConnect: async () => {
        await appendNativeAdminSocketAudit("connect", admission, { connectionId });
      },
      onClose: (cause: NativeAdminWebSocketCloseCause) => {
        const closeReason = nativeAdminShuttingDown ? "shutdown" : cause.reason;
        const closeAudit = appendNativeAdminSocketAudit("close", admission, {
          connectionId: cause.connectionId,
          closeReason,
        }).catch((error) => {
          app.log.warn({
            event: "native_admin.websocket_audit_failed",
            error,
            namespaceId: admission.namespaceId,
            agentId: admission.agentId,
            revisionId: admission.revisionId,
          });
        });
        nativeAdminCloseAudits.add(closeAudit);
        closeAudit.finally(() => nativeAdminCloseAudits.delete(closeAudit));
      },
    });
  }

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
    if (isAuthorizationDenied(error) && !isDependencyUnavailable(error)) {
      const context = contexts.get(request);
      if (context) {
        try {
          await denial(
            context.operation,
            request,
            "authorization_denial",
            context,
            error.evidence,
            error.authorization,
          );
        } catch (auditError) {
          mapped = requestFailure(auditError);
        }
      }
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

export const createOccApi = createControllerApp;

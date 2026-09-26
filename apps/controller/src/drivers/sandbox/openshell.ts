import { asRecord, isNonEmptyString, sha256Hex } from "@openclaw-enterprise/utils";
import { KubernetesObjectApi, type KubernetesObject, PatchStrategy } from "@kubernetes/client-node";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AgentRevision,
  HarnessWorkloadRequirements,
  KubernetesNamespacedResource,
  Namespace,
  OpenClawConfigurationDocument,
  OpenClawConfigurationValue,
  SandboxDriver,
  SandboxHarnessContext,
  SandboxNamespaceContext,
  SandboxResourceRef,
} from "@openclaw-enterprise/contracts";
import {
  GrpcOpenShellGatewayClient,
  type OpenShellGatewayClient,
  type OpenShellGatewayClientOptions,
  type OpenShellWorkspaceResponse,
  OpenShellSandboxAlreadyExistsError,
  OpenShellWorkspaceAlreadyExistsError,
  toProtobufStruct,
} from "./openshell-gateway-client.ts";

type ConfigurationRecord = Readonly<Record<string, unknown>>;

export interface OpenShellKubernetesNetworkPeer {
  readonly namespaceName: string;
  readonly podLabels: Readonly<Record<string, string>>;
}

export interface OpenShellNetworkEndpoint {
  readonly host: string;
  readonly ports: readonly number[];
  readonly protocol?: string;
  readonly tls?: "skip" | "terminate";
  readonly enforcement?: "enforce" | "audit";
  readonly access?: "read_only" | "read_write" | "full";
}

export interface OpenShellNetworkPolicyRule {
  readonly name: string;
  readonly endpoints: readonly OpenShellNetworkEndpoint[];
  readonly binaries: readonly OpenShellNetworkBinary[];
}

export interface OpenShellNetworkBinary {
  readonly path: string;
}

export interface OpenShellSandboxDriverOptions {
  readonly gateway: Omit<OpenShellGatewayClientOptions, "endpoint"> & {
    readonly workspaceMode: "managed" | "operator";
    readonly endpoint?: string;
    readonly scheme?: "http" | "https";
    readonly serviceName?: string;
    readonly port?: number;
    readonly operatorNamespaceLabels?: Readonly<Record<string, string>>;
    readonly readiness?: {
      readonly serviceName: string;
      readonly podSelector: Readonly<Record<string, string>>;
      readonly timeoutMs?: number;
      readonly pollIntervalMs?: number;
    };
    readonly operatorWorkspaceResources?: readonly KubernetesNamespacedResource[];
    readonly networkPolicyResources?: readonly KubernetesNamespacedResource[];
  };
  readonly kubernetes: {
    readonly runtimeClassName: string;
    readonly serviceAccount: { readonly mode: "gatewayConfigured" };
    readonly sandboxDataMount: {
      readonly claimName?: string;
      readonly subPath: string;
      readonly mountPath: string;
      readonly readOnly: boolean;
    };
    readonly agentResources?: ConfigurationRecord;
    readonly userNamespaces?: boolean;
  };
  readonly policy: {
    readonly filesystem?: {
      readonly includeWorkdir?: boolean;
      readonly readOnly?: readonly string[];
      readonly readWrite?: readonly string[];
    };
    readonly landlockCompatibility?: string;
    readonly process: {
      readonly runAsUser: string;
      readonly runAsGroup: string;
    };
    readonly networkPolicies: readonly OpenShellNetworkPolicyRule[];
  };
  readonly sandboxNamePrefix?: string;
  readonly logLevel?: string;
  readonly providers?: readonly string[];
}

export interface OpenShellSandboxDriverSelection {
  readonly id?: string;
  readonly implementation?: string;
  readonly gatewayClient?: OpenShellGatewayClient;
}

class OpenShellSandboxConfigurationFailure extends Error {}

const NETWORK_TLS_MODES = Object.freeze({
  skip: "NETWORK_TLS_MODE_SKIP",
  terminate: "NETWORK_TLS_MODE_TERMINATE",
});
const NETWORK_ENFORCEMENT_MODES = Object.freeze({
  enforce: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
  audit: "NETWORK_ENFORCEMENT_MODE_AUDIT",
});
const NETWORK_ACCESS_PRESETS = Object.freeze({
  read_only: "NETWORK_ACCESS_PRESET_READ_ONLY",
  read_write: "NETWORK_ACCESS_PRESET_READ_WRITE",
  full: "NETWORK_ACCESS_PRESET_FULL",
});

function optionalEnumValue(
  value: unknown,
  values: Readonly<Record<string, string>>,
  description: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const key = nonempty(value, description);
  if (!Object.hasOwn(values, key)) {
    throw new OpenShellSandboxConfigurationFailure(
      `${description} must be one of: ${Object.keys(values).join(", ")}.`,
    );
  }
  return values[key];
}

const DEFAULT_SANDBOX_NAME_PREFIX = "sb";
const DEFAULT_GATEWAY_PORT = 8080;
const OPENSHELL_MAX_SANDBOX_NAME_LENGTH = 19;
const OPENSHELL_MAX_WORKSPACE_NAME_LENGTH = 19;
const OPENSHELL_MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
const OPENSHELL_NAMESPACE_ID_LABEL = "openclaw.dev/namespace-id";
const OPENSHELL_MANAGED_BY = "openclaw-enterprise";
const SERVICE_PRINCIPAL_VOLUME = "openclaw-service-principal";
const APP_SERVER_PORT_ENVIRONMENT = "APP_SERVER_PORT";
const OPERATOR_WORKSPACE_RESOURCE_VERSIONS = Object.freeze({
  ServiceAccount: "v1",
  Role: "rbac.authorization.k8s.io/v1",
  RoleBinding: "rbac.authorization.k8s.io/v1",
  NetworkPolicy: "networking.k8s.io/v1",
});

function nonempty(value: unknown, description: string): string {
  if (!isNonEmptyString(value)) {
    throw new OpenShellSandboxConfigurationFailure(`${description} must be a nonempty string.`);
  }
  return value;
}

function configurationObject(value: unknown, description: string): ConfigurationRecord {
  const object = asRecord(value);
  if (object === undefined) {
    throw new OpenShellSandboxConfigurationFailure(`${description} must be an object.`);
  }
  return object;
}

function optionalAgentConfiguration(
  value: OpenClawConfigurationValue | undefined,
  description: string,
): Readonly<Record<string, OpenClawConfigurationValue>> {
  return value === undefined
    ? {}
    : (configurationObject(value, description) as Readonly<
        Record<string, OpenClawConfigurationValue>
      >);
}

function labels(value: Readonly<Record<string, string>>, description: string): void {
  if (asRecord(value) === undefined || Object.keys(value).length === 0) {
    throw new OpenShellSandboxConfigurationFailure(
      `${description} must contain at least one label.`,
    );
  }
  for (const [key, entry] of Object.entries(value)) {
    nonempty(key, `${description} key`);
    nonempty(entry, `${description}.${key}`);
  }
}

function port(value: unknown, description: string): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new OpenShellSandboxConfigurationFailure(`${description} must be a valid TCP port.`);
  }
  return Number(value);
}

function optionalPort(value: unknown, description: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return port(value, description);
}

function validateKubernetesResource(value: unknown, path: string): void {
  const resource = asRecord(value);
  const metadata = asRecord(resource?.metadata);
  if (
    resource === undefined ||
    typeof resource.apiVersion !== "string" ||
    typeof resource.kind !== "string" ||
    metadata === undefined ||
    typeof metadata.name !== "string" ||
    metadata.name.trim().length === 0
  ) {
    throw new OpenShellSandboxConfigurationFailure(`${path} must be a Kubernetes resource object.`);
  }
  if (resource.kind === "Secret") {
    throw new OpenShellSandboxConfigurationFailure(
      `${path} must not contain OpenShell credential-bearing Secrets.`,
    );
  }
}

function validateOperatorWorkspaceResource(value: unknown, path: string): void {
  validateKubernetesResource(value, path);
  const resource = value as KubernetesNamespacedResource;
  const expected =
    OPERATOR_WORKSPACE_RESOURCE_VERSIONS[
      resource.kind as keyof typeof OPERATOR_WORKSPACE_RESOURCE_VERSIONS
    ];
  if (expected === undefined || resource.apiVersion !== expected) {
    throw new OpenShellSandboxConfigurationFailure(
      `${path} must be a workspace-chart ServiceAccount, Role, RoleBinding, or NetworkPolicy.`,
    );
  }
}

function validateWorkspaceMount(mount: {
  readonly claimName: string;
  readonly subPath: string;
  readonly mountPath: string;
  readonly readOnly: boolean;
}): void {
  nonempty(mount.claimName, "Workspace mount claimName");
  const subPath = nonempty(mount.subPath, "Workspace mount subPath");
  if (subPath === "/" || subPath.startsWith("/") || subPath.includes("..")) {
    throw new OpenShellSandboxConfigurationFailure("Workspace mounts must use exact PVC subpaths.");
  }
  const mountPath = nonempty(mount.mountPath, "Workspace mount path");
  if (!mountPath.startsWith("/")) {
    throw new OpenShellSandboxConfigurationFailure("Workspace mount path must be absolute.");
  }
  if (typeof mount.readOnly !== "boolean") {
    throw new OpenShellSandboxConfigurationFailure("Workspace mount readOnly must be explicit.");
  }
}

function validateSandboxDataMount(mount: {
  readonly claimName?: string;
  readonly subPath: string;
  readonly mountPath: string;
  readonly readOnly: boolean;
}): void {
  if (mount.claimName !== undefined) {
    nonempty(mount.claimName, "OpenShell sandboxDataMount claimName");
  }
  const subPath = nonempty(mount.subPath, "OpenShell sandboxDataMount subPath");
  if (subPath === "." || subPath === "/" || subPath.startsWith("/") || subPath.includes("..")) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell sandboxDataMount must use an exact PVC subpath.",
    );
  }
  const mountPath = nonempty(mount.mountPath, "OpenShell sandboxDataMount mountPath");
  if (!mountPath.startsWith("/sandbox/")) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell sandboxDataMount must mount an approved PVC subpath under /sandbox.",
    );
  }
  if (typeof mount.readOnly !== "boolean") {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell sandboxDataMount readOnly must be explicit.",
    );
  }
}

function environment(requirements: HarnessWorkloadRequirements): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of requirements.environment) {
    if ("valueFrom" in entry) {
      throw new OpenShellSandboxConfigurationFailure(
        `OpenShell v0.1.0 cannot receive secretKeyRef environment ${entry.name}; upstream Secret projection support is required.`,
      );
    }
    result[nonempty(entry.name, "Environment variable name")] = entry.value;
  }
  return result;
}

function harnessPort(requirements: HarnessWorkloadRequirements): number {
  const entry = requirements.environment.find(
    (candidate) => candidate.name === APP_SERVER_PORT_ENVIRONMENT,
  );
  if (entry === undefined || "valueFrom" in entry) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell requires a literal APP_SERVER_PORT for create-time service exposure.",
    );
  }
  return port(Number(entry.value), "OpenShell APP_SERVER_PORT");
}

function requestId(revisionId: string): string {
  const match = /^rev_([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/.exec(revisionId);
  if (match === null) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell requires an Agent revision ID containing a stable UUID.",
    );
  }
  return match[1]!;
}

function validateHarnessServiceUrl(value: unknown): void {
  const endpoint = nonempty(value, "OpenShell Harness service URL");
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell returned an invalid Harness service URL.",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell Harness service URL must use HTTP or HTTPS.",
    );
  }
}

function namespaceName(namespace: Readonly<Namespace>): string {
  return nonempty(namespace.name, "Kubernetes namespace name");
}

function workspaceName(namespace: Readonly<Namespace>): string {
  const name = namespaceName(namespace);
  if (
    name.length > OPENSHELL_MAX_WORKSPACE_NAME_LENGTH ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)
  ) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell operator-mode Workspace names require a Kubernetes namespace name that is a DNS-1123 label of at most 19 characters.",
    );
  }
  return name;
}

function workspaceLabels(namespace: Readonly<Namespace>): Readonly<Record<string, string>> {
  return Object.freeze({
    [OPENSHELL_MANAGED_BY_LABEL]: OPENSHELL_MANAGED_BY,
    [OPENSHELL_NAMESPACE_ID_LABEL]: nonempty(namespace.id, "OCC Namespace ID"),
  });
}

function verifyWorkspaceOwnership(
  workspace: OpenShellWorkspaceResponse,
  namespace: Readonly<Namespace>,
): void {
  const expectedName = workspaceName(namespace);
  const expectedLabels = workspaceLabels(namespace);
  if (
    workspace.name !== expectedName ||
    Object.entries(expectedLabels).some(([key, value]) => workspace.labels[key] !== value)
  ) {
    throw new OpenShellSandboxConfigurationFailure(
      `Refusing OpenShell Workspace ${workspace.name} without exact OCC Namespace ownership.`,
    );
  }
}

function verifyActiveWorkspace(
  workspace: OpenShellWorkspaceResponse,
  namespace: Readonly<Namespace>,
): void {
  verifyWorkspaceOwnership(workspace, namespace);
  if (workspace.phase !== "WORKSPACE_PHASE_ACTIVE" && workspace.phase !== 1) {
    throw new OpenShellSandboxConfigurationFailure(
      `OpenShell Workspace ${workspace.name} is not active.`,
    );
  }
}

function resourceNamespace(resource: KubernetesNamespacedResource): string | undefined {
  const namespace = asRecord(resource.metadata)?.namespace;
  return typeof namespace === "string" && namespace.trim().length > 0 ? namespace : undefined;
}

function resourceReference(resource: KubernetesNamespacedResource, namespace: string) {
  return {
    apiVersion: nonempty(resource.apiVersion, "Kubernetes resource apiVersion"),
    kind: nonempty(resource.kind, "Kubernetes resource kind"),
    metadata: {
      namespace,
      name: nonempty(asRecord(resource.metadata)?.name, "Kubernetes resource name"),
    },
  };
}

function withNamespace(
  resource: KubernetesNamespacedResource,
  context: SandboxNamespaceContext,
): KubernetesObject {
  const namespace = namespaceName(context.namespace);
  const current = resourceNamespace(resource);
  if (current !== undefined && current !== namespace) {
    throw new OpenShellSandboxConfigurationFailure(
      `OpenShell resource ${resource.kind}/${asRecord(resource.metadata)?.name} targets namespace ${current}, not ${namespace}.`,
    );
  }
  const metadata = asRecord(resource.metadata);
  const resourceLabels = asRecord(metadata?.labels);
  const resourceAnnotations = asRecord(metadata?.annotations);
  const namespaceId = context.namespace.id;
  if (
    (resourceLabels?.["openclaw.dev/namespace"] !== undefined &&
      resourceLabels["openclaw.dev/namespace"] !== namespaceId) ||
    (resourceAnnotations?.["openclaw.dev/namespace-id"] !== undefined &&
      resourceAnnotations["openclaw.dev/namespace-id"] !== namespaceId)
  ) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell bootstrap resource belongs to another Namespace.",
    );
  }
  return {
    ...resource,
    apiVersion: nonempty(resource.apiVersion, "Kubernetes resource apiVersion"),
    kind: nonempty(resource.kind, "Kubernetes resource kind"),
    metadata: {
      ...metadata,
      name: nonempty(metadata?.name, "Kubernetes resource name"),
      namespace,
      labels: {
        ...resourceLabels,
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": namespaceId,
      },
      annotations: {
        ...resourceAnnotations,
        "openclaw.dev/namespace-id": namespaceId,
      },
    },
  };
}

function kubernetes(context: SandboxNamespaceContext): KubernetesObjectApi {
  if (!(context.kubernetes instanceof KubernetesObjectApi)) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell requires the Compute Driver's native Kubernetes object client.",
    );
  }
  return context.kubernetes;
}

function missingResource(error: unknown): boolean {
  const observed = asRecord(error);
  const response = asRecord(observed?.response);
  return [observed?.code, observed?.statusCode, response?.statusCode, response?.status].includes(
    404,
  );
}

async function applyResources(
  context: SandboxNamespaceContext,
  resources: readonly KubernetesNamespacedResource[] | undefined,
): Promise<void> {
  for (const resource of resources ?? []) {
    await kubernetes(context).patch(
      withNamespace(resource, context),
      undefined,
      undefined,
      "openclaw-enterprise-sandbox",
      false,
      PatchStrategy.ServerSideApply,
    );
  }
}

async function applyOperatorNamespaceLabels(
  context: SandboxNamespaceContext,
  desired: Readonly<Record<string, string>> | undefined,
): Promise<void> {
  if (desired === undefined) {
    return;
  }
  const name = namespaceName(context.namespace);
  const existing = await kubernetes(context).read({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name },
  });
  if (existing === undefined) {
    throw new OpenShellSandboxConfigurationFailure(
      `OpenShell operator Namespace ${name} is unavailable.`,
    );
  }
  const current = asRecord(existing.metadata?.labels) ?? {};
  for (const [key, value] of Object.entries(desired)) {
    if (current[key] !== undefined && current[key] !== value) {
      throw new OpenShellSandboxConfigurationFailure(
        `OpenShell operator Namespace label ${key} is owned with another value.`,
      );
    }
  }
  await kubernetes(context).patch(
    {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name, labels: { ...desired } },
    },
    undefined,
    undefined,
    "openclaw-enterprise-sandbox",
    false,
    PatchStrategy.ServerSideApply,
  );
}

function labelSelector(selector: Readonly<Record<string, string>>): string {
  return Object.entries(selector)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

function podReady(pod: ConfigurationRecord): boolean {
  const status = asRecord(pod.status);
  const conditions = Array.isArray(status?.conditions) ? status.conditions : [];
  return conditions.some((condition) => {
    const value = asRecord(condition);
    return value?.type === "Ready" && value.status === "True";
  });
}

async function waitForGatewayReadiness(
  context: SandboxNamespaceContext,
  readiness: NonNullable<OpenShellSandboxDriverOptions["gateway"]["readiness"]>,
): Promise<void> {
  const namespace = namespaceName(context.namespace);
  const deadline = Date.now() + (readiness.timeoutMs ?? 0);
  const pollIntervalMs = readiness.pollIntervalMs ?? 1_000;
  let unavailable = "OpenShell gateway Service is unavailable.";
  for (;;) {
    let service: KubernetesObject | undefined;
    try {
      service = await kubernetes(context).read({
        apiVersion: "v1",
        kind: "Service",
        metadata: { namespace, name: readiness.serviceName },
      });
    } catch (error) {
      if (!missingResource(error)) {
        throw error;
      }
    }
    if (service !== undefined) {
      const pods = await kubernetes(context).list(
        "v1",
        "Pod",
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        labelSelector(readiness.podSelector),
      );
      if (pods.items.some((pod) => podReady(pod as ConfigurationRecord))) {
        return;
      }
      unavailable = "OpenShell gateway Pod is not ready.";
    }
    if (Date.now() >= deadline) {
      throw new OpenShellSandboxConfigurationFailure(unavailable);
    }
    await delay(pollIntervalMs, undefined, { signal: context.signal });
  }
}

function gatewayEndpoint(options: OpenShellSandboxDriverOptions, namespace: string): string {
  if (options.gateway.endpoint !== undefined) {
    return nonempty(options.gateway.endpoint, "OpenShell gateway endpoint");
  }
  const serviceName = nonempty(
    options.gateway.serviceName ?? options.gateway.readiness?.serviceName,
    "OpenShell gateway Service name",
  );
  const servicePort =
    optionalPort(options.gateway.port, "OpenShell gateway port") ?? DEFAULT_GATEWAY_PORT;
  const scheme =
    options.gateway.scheme ??
    (options.gateway.rootCertificatePath === undefined ? "http" : "https");
  const host = serviceName.includes(".") ? serviceName : `${serviceName}.${namespace}.svc`;
  return `${scheme}://${host}:${servicePort}`;
}

function gatewayClientOptions(
  options: OpenShellSandboxDriverOptions,
  namespace: string,
): OpenShellGatewayClientOptions {
  return {
    endpoint: gatewayEndpoint(options, namespace),
    ...(options.gateway.auth === undefined ? {} : { auth: options.gateway.auth }),
    ...(options.gateway.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.gateway.requestTimeoutMs }),
    ...(options.gateway.rootCertificatePath === undefined
      ? {}
      : { rootCertificatePath: options.gateway.rootCertificatePath }),
  };
}

function workspaceVolumeName(claimName: string): string {
  return `workspace-${sha256Hex(claimName, 12)}`;
}

function workspaceVolumeMounts(requirements: HarnessWorkloadRequirements) {
  const volumes = new Map<string, { readonly claimName: string; readOnly: boolean }>();
  const mounts = requirements.workspaceMounts.map((mount) => {
    validateWorkspaceMount(mount);
    const name = workspaceVolumeName(mount.claimName);
    const existing = volumes.get(name);
    if (existing === undefined) {
      volumes.set(name, { claimName: mount.claimName, readOnly: mount.readOnly });
    } else if (!mount.readOnly) {
      volumes.set(name, { ...existing, readOnly: false });
    }
    return {
      name,
      mount_path: mount.mountPath,
      sub_path: mount.subPath,
      read_only: mount.readOnly,
    };
  });
  return {
    volumes: Array.from(volumes.values(), (volume) => ({
      name: workspaceVolumeName(volume.claimName),
      persistent_volume_claim: {
        claim_name: volume.claimName,
        read_only: volume.readOnly,
      },
    })),
    mounts,
  };
}

function servicePrincipalVolume(requirements: HarnessWorkloadRequirements) {
  const token = configurationObject(
    requirements.serviceAccountToken,
    "Harness ServicePrincipal token projection",
  );
  const audience = nonempty(token.audience, "Harness ServicePrincipal token audience");
  const expirationSeconds = token.expirationSeconds;
  const path = nonempty(token.path, "Harness ServicePrincipal token path");
  const mountPath = nonempty(token.mountPath, "Harness ServicePrincipal token mount path");
  if (
    typeof expirationSeconds !== "number" ||
    !Number.isSafeInteger(expirationSeconds) ||
    expirationSeconds < 600 ||
    expirationSeconds > 86_400 ||
    path !== "token" ||
    !mountPath.startsWith("/") ||
    mountPath === "/" ||
    mountPath.includes("..") ||
    token.readOnly !== true
  ) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell must preserve the exact approved read-only ServicePrincipal token projection.",
    );
  }
  return {
    volume: {
      name: SERVICE_PRINCIPAL_VOLUME,
      projected: {
        sources: [
          {
            service_account_token: {
              audience,
              expiration_seconds: expirationSeconds,
              path,
            },
          },
        ],
      },
    },
    mount: {
      name: SERVICE_PRINCIPAL_VOLUME,
      mount_path: mountPath,
      read_only: true,
    },
  };
}

function sandboxDataMount(
  options: OpenShellSandboxDriverOptions,
  requirements: HarnessWorkloadRequirements,
) {
  const mount = options.kubernetes.sandboxDataMount;
  validateSandboxDataMount(mount);
  const candidates = requirements.workspaceMounts.filter(
    (candidate) =>
      candidate.subPath === mount.subPath &&
      (mount.claimName === undefined || candidate.claimName === mount.claimName),
  );
  const approvedClaimNames = Array.from(
    new Set(candidates.map((candidate) => candidate.claimName)),
  );
  if (approvedClaimNames.length !== 1) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell sandboxDataMount must exactly match one approved Harness workspace mount.",
    );
  }
  const claimName = approvedClaimNames[0]!;
  const approvedMount = candidates.find((candidate) => candidate.claimName === claimName)!;
  if (approvedMount.readOnly && !mount.readOnly) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell sandboxDataMount must not weaken an approved read-only workspace mount.",
    );
  }
  if (!mount.mountPath.startsWith("/sandbox/")) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell sandboxDataMount must mount an approved PVC subpath under /sandbox.",
    );
  }
  if (!requirements.workspaceMounts.some((candidate) => candidate.claimName === claimName)) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell sandboxDataMount must reuse an approved workspace PVC.",
    );
  }
  return {
    name: workspaceVolumeName(claimName),
    mount_path: mount.mountPath,
    sub_path: mount.subPath,
    read_only: mount.readOnly,
  };
}

function validateFilesystemPolicyPath(path: string, description: string): string {
  const value = nonempty(path, description);
  if (value === "/" || !value.startsWith("/") || value.includes("\0")) {
    throw new OpenShellSandboxConfigurationFailure(
      `${description} must be an exact non-root absolute path.`,
    );
  }
  return value;
}

function filesystemPolicy(
  options: OpenShellSandboxDriverOptions,
  requirements: HarnessWorkloadRequirements,
  dataMount: { readonly mount_path: string; readonly read_only: boolean },
) {
  const readOnly = new Set(
    (options.policy.filesystem?.readOnly ?? []).map((path) =>
      validateFilesystemPolicyPath(path, "OpenShell configured read-only filesystem path"),
    ),
  );
  const readWrite = new Set(
    (options.policy.filesystem?.readWrite ?? []).map((path) =>
      validateFilesystemPolicyPath(path, "OpenShell configured read-write filesystem path"),
    ),
  );

  const addMountPolicy = (path: string, readOnlyMount: boolean) => {
    const normalized = validateFilesystemPolicyPath(path, "Harness workspace mount path");
    if (readOnlyMount) {
      if (readWrite.has(normalized)) {
        throw new OpenShellSandboxConfigurationFailure(
          `OpenShell filesystem policy must not grant read-write access to read-only mount ${normalized}.`,
        );
      }
      readOnly.add(normalized);
      return;
    }
    readOnly.delete(normalized);
    readWrite.add(normalized);
  };

  for (const mount of requirements.workspaceMounts) {
    validateWorkspaceMount(mount);
    addMountPolicy(mount.mountPath, mount.readOnly);
  }
  addMountPolicy(requirements.serviceAccountToken.mountPath, true);
  addMountPolicy(dataMount.mount_path, dataMount.read_only);

  return {
    include_workdir: options.policy.filesystem?.includeWorkdir ?? true,
    read_only: [...readOnly],
    read_write: [...readWrite],
  };
}

function networkPolicies(options: OpenShellSandboxDriverOptions) {
  return Object.fromEntries(
    options.policy.networkPolicies.map((policy) => [
      nonempty(policy.name, "OpenShell network policy name"),
      {
        name: policy.name,
        binaries: networkPolicyBinaries(policy),
        endpoints: policy.endpoints.map((endpoint) => {
          const description = `OpenShell network policy ${policy.name}`;
          const tls = optionalEnumValue(endpoint.tls, NETWORK_TLS_MODES, `${description} TLS mode`);
          const enforcement = optionalEnumValue(
            endpoint.enforcement,
            NETWORK_ENFORCEMENT_MODES,
            `${description} enforcement mode`,
          );
          const access = optionalEnumValue(
            endpoint.access,
            NETWORK_ACCESS_PRESETS,
            `${description} access preset`,
          );
          return {
            host: nonempty(endpoint.host, `${description} host`),
            ports: endpoint.ports.map((value) => port(value, `${description} port`)),
            ...(endpoint.protocol === undefined ? {} : { protocol: endpoint.protocol }),
            ...(tls === undefined ? {} : { tls }),
            ...(enforcement === undefined ? {} : { enforcement }),
            ...(access === undefined ? {} : { access }),
          };
        }),
      },
    ]),
  );
}

function networkPolicyBinaries(policy: OpenShellNetworkPolicyRule) {
  if (!Array.isArray(policy.binaries) || policy.binaries.length === 0) {
    throw new OpenShellSandboxConfigurationFailure(
      `OpenShell network policy ${policy.name} requires at least one binary path.`,
    );
  }
  return policy.binaries.map((binary) => ({
    path: nonempty(binary.path, `OpenShell network policy ${policy.name} binary path`),
  }));
}

function sandboxSpec(
  options: OpenShellSandboxDriverOptions,
  requirements: HarnessWorkloadRequirements,
) {
  const workspace = workspaceVolumeMounts(requirements);
  const servicePrincipal = servicePrincipalVolume(requirements);
  const dataMount = sandboxDataMount(options, requirements);
  const volumeMounts = workspace.mounts.some(
    (mount) =>
      mount.name === dataMount.name &&
      mount.mount_path === dataMount.mount_path &&
      mount.sub_path === dataMount.sub_path,
  )
    ? workspace.mounts
    : [...workspace.mounts, dataMount];
  const podConfig: Record<string, unknown> = {
    runtime_class_name: options.kubernetes.runtimeClassName,
  };
  const driverConfig = {
    pod: podConfig,
    containers: {
      agent: {
        resources: options.kubernetes.agentResources ?? {},
        volume_mounts: [...volumeMounts, servicePrincipal.mount],
      },
    },
    volumes: [...workspace.volumes, servicePrincipal.volume],
  };
  return {
    log_level: options.logLevel ?? "info",
    environment: environment(requirements),
    template: {
      image: requirements.image,
      runtime_class_name: options.kubernetes.runtimeClassName,
      labels: { ...requirements.labels },
      annotations: {},
      driver_config: { fields: toProtobufStruct({ kubernetes: driverConfig }) },
      ...(options.kubernetes.userNamespaces === undefined
        ? {}
        : { user_namespaces: options.kubernetes.userNamespaces }),
    },
    policy: {
      version: 1,
      filesystem: filesystemPolicy(options, requirements, dataMount),
      landlock: { compatibility: options.policy.landlockCompatibility ?? "best_effort" },
      process: {
        run_as_user: options.policy.process.runAsUser,
        run_as_group: options.policy.process.runAsGroup,
      },
      network_policies: networkPolicies(options),
    },
    providers: [...(options.providers ?? [])],
    command: [...requirements.command],
    tty: false,
  };
}

function validateOptions(options: OpenShellSandboxDriverOptions): void {
  configurationObject(options, "OpenShell configuration");
  configurationObject(options.gateway, "OpenShell gateway configuration");
  configurationObject(options.kubernetes, "OpenShell Kubernetes configuration");
  configurationObject(options.kubernetes.serviceAccount, "OpenShell ServiceAccount configuration");
  configurationObject(options.policy, "OpenShell policy configuration");
  configurationObject(options.policy.process, "OpenShell process policy");
  if (options.gateway.workspaceMode !== "managed" && options.gateway.workspaceMode !== "operator") {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell gateway workspaceMode must be managed or operator.",
    );
  }
  if (options.gateway.endpoint !== undefined) {
    nonempty(options.gateway.endpoint, "OpenShell gateway endpoint");
  } else if (
    options.gateway.serviceName === undefined &&
    options.gateway.readiness?.serviceName === undefined
  ) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell gateway requires either endpoint or a namespace-local Service name.",
    );
  }
  if (
    options.gateway.scheme !== undefined &&
    options.gateway.scheme !== "http" &&
    options.gateway.scheme !== "https"
  ) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell gateway scheme must be http or https.",
    );
  }
  optionalPort(options.gateway.port, "OpenShell gateway port");
  if (options.gateway.operatorNamespaceLabels !== undefined) {
    labels(options.gateway.operatorNamespaceLabels, "OpenShell operator Namespace labels");
    if (Object.keys(options.gateway.operatorNamespaceLabels).length === 0) {
      throw new OpenShellSandboxConfigurationFailure(
        "OpenShell operator Namespace labels must not be empty.",
      );
    }
  }
  if (options.gateway.readiness !== undefined) {
    nonempty(options.gateway.readiness.serviceName, "OpenShell gateway Service name");
    labels(options.gateway.readiness.podSelector, "OpenShell gateway Pod selector");
    for (const [value, description] of [
      [options.gateway.readiness.timeoutMs, "OpenShell gateway readiness timeout"],
      [options.gateway.readiness.pollIntervalMs, "OpenShell gateway readiness poll interval"],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
        throw new OpenShellSandboxConfigurationFailure(
          `${description} must be a positive safe integer.`,
        );
      }
    }
  }
  options.gateway.networkPolicyResources?.forEach((resource, index) =>
    validateKubernetesResource(resource, `gateway.networkPolicyResources[${index}]`),
  );
  options.gateway.operatorWorkspaceResources?.forEach((resource, index) =>
    validateOperatorWorkspaceResource(resource, `gateway.operatorWorkspaceResources[${index}]`),
  );
  nonempty(options.kubernetes.runtimeClassName, "OpenShell RuntimeClass name");
  if (options.kubernetes.serviceAccount.mode !== "gatewayConfigured") {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell serviceAccount mode must be gatewayConfigured.",
    );
  }
  configurationObject(options.kubernetes.sandboxDataMount, "OpenShell sandbox data mount");
  validateSandboxDataMount(options.kubernetes.sandboxDataMount);
  nonempty(options.policy.process.runAsUser, "OpenShell process runAsUser");
  nonempty(options.policy.process.runAsGroup, "OpenShell process runAsGroup");
  if (
    !Array.isArray(options.policy.networkPolicies) ||
    options.policy.networkPolicies.length === 0
  ) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell requires at least one sandbox network policy.",
    );
  }
  networkPolicies(options);
  const prefix = nonempty(
    options.sandboxNamePrefix ?? DEFAULT_SANDBOX_NAME_PREFIX,
    "Sandbox name prefix",
  );
  if (prefix.length > OPENSHELL_MAX_SANDBOX_NAME_LENGTH - 17) {
    throw new OpenShellSandboxConfigurationFailure(
      "Sandbox name prefix is too long for OpenShell's 19-character limit.",
    );
  }
}

export const configurationSchema = Object.freeze({
  type: "object",
  required: ["gateway", "kubernetes", "policy"],
  additionalProperties: false,
  properties: {
    gateway: { type: "object" },
    kubernetes: { type: "object" },
    policy: { type: "object" },
    sandboxNamePrefix: { type: "string" },
    logLevel: { type: "string" },
    providers: { type: "array", items: { type: "string" } },
  },
});

export function validateConfiguration(configuration: unknown): void {
  const options = asRecord(configuration);
  if (options === undefined) {
    throw new OpenShellSandboxConfigurationFailure("OpenShell configuration is required.");
  }
  validateOptions(options as unknown as OpenShellSandboxDriverOptions);
}

export class OpenShellSandboxDriver implements SandboxDriver {
  static readonly configurationSchema = configurationSchema;

  readonly id: string;
  readonly capability = "sandbox" as const;
  readonly implementation: string;
  readonly facets = Object.freeze(["networking", "filesystem", "process"] as const);
  private readonly options: OpenShellSandboxDriverOptions;
  private readonly injectedGatewayClient: OpenShellGatewayClient | undefined;
  private readonly gatewayClients = new Map<string, OpenShellGatewayClient>();

  static validateConfiguration(configuration: unknown): void {
    validateConfiguration(configuration);
  }

  constructor(
    options: OpenShellSandboxDriverOptions,
    selection: OpenShellSandboxDriverSelection = {},
  ) {
    validateOptions(options);
    this.id = nonempty(selection.id ?? "sandbox-openshell-local", "OpenShell Sandbox Driver ID");
    this.implementation = nonempty(
      selection.implementation ?? "openshell",
      "OpenShell Sandbox Driver implementation",
    );
    if (this.implementation !== "openshell") {
      throw new OpenShellSandboxConfigurationFailure(
        "OpenShell Sandbox Driver implementation must be exactly openshell.",
      );
    }
    this.options = options;
    this.injectedGatewayClient = selection.gatewayClient;
  }

  configureAgent(
    configuration: Readonly<OpenClawConfigurationDocument>,
  ): OpenClawConfigurationDocument {
    const plugins = optionalAgentConfiguration(
      configuration.plugins,
      "OpenShell Sandbox plugin configuration",
    );
    const entries = optionalAgentConfiguration(plugins.entries, "OpenShell Sandbox plugin entries");
    const codex = optionalAgentConfiguration(entries.codex, "OpenShell Sandbox Codex plugin entry");
    const codexConfig = optionalAgentConfiguration(
      codex.config,
      "OpenShell Sandbox Codex plugin config",
    );
    const appServer = optionalAgentConfiguration(
      codexConfig.appServer,
      "OpenShell Sandbox Codex app-server config",
    );

    return {
      ...configuration,
      plugins: {
        ...plugins,
        entries: {
          ...entries,
          codex: {
            ...codex,
            enabled: true,
            config: {
              ...codexConfig,
              appServer: {
                ...appServer,
                sandbox: "danger-full-access",
              },
            },
          },
        },
      },
    };
  }

  async ensureNamespace(context: SandboxNamespaceContext): Promise<void> {
    this.requireOperatorWorkspaceMode("ensure a Namespace");
    const namespace = namespaceName(context.namespace);
    await applyOperatorNamespaceLabels(context, this.options.gateway.operatorNamespaceLabels);
    await applyResources(context, this.options.gateway.operatorWorkspaceResources);
    await applyResources(context, this.options.gateway.networkPolicyResources);
    if (this.options.gateway.readiness !== undefined) {
      await waitForGatewayReadiness(context, this.options.gateway.readiness);
    }
    const client = this.gatewayClientForNamespace(namespace);
    await client.health(context.signal);
    const name = workspaceName(context.namespace);
    let workspace = await client.getWorkspace(name, context.signal);
    if (workspace === undefined) {
      try {
        workspace = await client.createWorkspace(
          name,
          workspaceLabels(context.namespace),
          context.signal,
        );
      } catch (error) {
        if (!(error instanceof OpenShellWorkspaceAlreadyExistsError)) {
          throw error;
        }
        workspace = await client.getWorkspace(name, context.signal);
        if (workspace === undefined) {
          throw new OpenShellSandboxConfigurationFailure(
            `OpenShell Workspace ${name} disappeared during creation.`,
          );
        }
      }
    }
    verifyActiveWorkspace(workspace, context.namespace);
  }

  async provisionHarness(context: SandboxHarnessContext): Promise<SandboxResourceRef> {
    this.requireOperatorWorkspaceMode("provision a Harness");
    if (context.revision.harness.mode !== "dedicated" || context.revision.harness.id !== "codex") {
      throw new OpenShellSandboxConfigurationFailure(
        "OpenShell SandboxDriver only supports dedicated Codex Harness revisions.",
      );
    }
    if (
      context.revision.sandboxDriverId !== undefined &&
      context.revision.sandboxDriverId !== this.id
    ) {
      throw new OpenShellSandboxConfigurationFailure(
        "Refusing an AgentRevision pinned to another Sandbox Driver.",
      );
    }
    labels(context.requirements.labels, "Harness workload labels");
    const sandbox = this.sandboxRef(context);
    const targetPort = harnessPort(context.requirements);
    let created;
    try {
      created = await this.gatewayClientForNamespace(sandbox.namespaceName).createSandbox(
        {
          name: sandbox.resourceName,
          workspace: workspaceName(context.namespace),
          requestId: requestId(context.revision.id),
          labels: context.requirements.labels,
          annotations: {
            "openclaw.dev/namespace-id": context.revision.namespaceId,
            "openclaw.dev/agent-id": context.revision.agentId,
            "openclaw.dev/revision-id": context.revision.id,
          },
          spec: sandboxSpec(this.options, context.requirements),
          serviceExposures: [{ service: "", targetPort }],
        },
        context.signal,
      );
    } catch (error) {
      if (error instanceof OpenShellSandboxAlreadyExistsError) {
        throw new OpenShellSandboxConfigurationFailure(
          "OpenShell Sandbox already exists without a replayable create-time service URL; remove the stale Sandbox before retrying.",
        );
      }
      throw error;
    }
    if (created.name !== sandbox.resourceName) {
      throw new OpenShellSandboxConfigurationFailure(
        "OpenShell returned a different Sandbox name than requested.",
      );
    }
    validateHarnessServiceUrl(created.serviceUrls[""]);
    return Object.freeze(sandbox);
  }

  async cleanup(
    context: SandboxNamespaceContext & { readonly revision?: Readonly<AgentRevision> },
  ): Promise<void> {
    if (context.revision !== undefined) {
      this.requireOperatorWorkspaceMode("clean up a revision");
      if (
        context.revision.namespaceId !== context.namespace.id ||
        context.revision.sandboxDriverId !== this.id
      ) {
        throw new OpenShellSandboxConfigurationFailure(
          "Refusing to delete a Sandbox outside its selected AgentRevision and Namespace.",
        );
      }
      const sandbox = this.sandboxRef({ namespace: context.namespace, revision: context.revision });
      await this.gatewayClientForNamespace(sandbox.namespaceName).deleteSandbox(
        {
          name: sandbox.resourceName,
          workspace: workspaceName(context.namespace),
        },
        context.signal,
      );
      return;
    }
    this.requireOperatorWorkspaceMode("clean up a Namespace");
    const namespace = namespaceName(context.namespace);
    const client = this.gatewayClientForNamespace(namespace);
    const workspace = await client.getWorkspace(workspaceName(context.namespace), context.signal);
    if (workspace !== undefined) {
      // A prior delete can have reached TERMINATING before its response was lost.
      // Ownership remains the cleanup boundary, and DeleteWorkspace is idempotent.
      verifyWorkspaceOwnership(workspace, context.namespace);
      await client.deleteWorkspace(workspace.name, context.signal);
    }
    const resources = [
      ...(this.options.gateway.operatorWorkspaceResources ?? []),
      ...(this.options.gateway.networkPolicyResources ?? []),
    ];
    for (const resource of resources.reverse()) {
      try {
        await kubernetes(context).delete(resourceReference(resource, namespace));
      } catch (error) {
        if (!missingResource(error)) {
          throw error;
        }
      }
    }
  }

  close(): void {
    this.injectedGatewayClient?.close();
    for (const client of this.gatewayClients.values()) {
      client.close();
    }
    this.gatewayClients.clear();
  }

  private gatewayClientForNamespace(namespace: string): OpenShellGatewayClient {
    if (this.injectedGatewayClient !== undefined) {
      return this.injectedGatewayClient;
    }
    const options = gatewayClientOptions(this.options, namespace);
    const existing = this.gatewayClients.get(options.endpoint);
    if (existing !== undefined) {
      return existing;
    }
    const created = new GrpcOpenShellGatewayClient(options);
    this.gatewayClients.set(options.endpoint, created);
    return created;
  }

  private requireOperatorWorkspaceMode(operation: string): void {
    if (this.options.gateway.workspaceMode === "managed") {
      throw new OpenShellSandboxConfigurationFailure(
        `OpenShell managed workspace mode is not implemented; cannot ${operation}.`,
      );
    }
  }

  private sandboxRef(
    context: Pick<SandboxHarnessContext, "namespace" | "revision">,
  ): SandboxResourceRef {
    const prefix = this.options.sandboxNamePrefix ?? DEFAULT_SANDBOX_NAME_PREFIX;
    const hashLength = OPENSHELL_MAX_SANDBOX_NAME_LENGTH - prefix.length - 1;
    return Object.freeze({
      namespaceName: namespaceName(context.namespace),
      resourceName: `${prefix}-${sha256Hex(context.revision.id, hashLength)}`,
      agentId: context.revision.agentId,
      revisionId: context.revision.id,
    });
  }
}

export function createOpenShellSandboxDriver(
  options: OpenShellSandboxDriverOptions,
  selection?: OpenShellSandboxDriverSelection,
): OpenShellSandboxDriver {
  return new OpenShellSandboxDriver(options, selection);
}

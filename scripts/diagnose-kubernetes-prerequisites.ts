#!/usr/bin/env node
import { spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";

type PeakAdditional = { jobs: number; replicaSets: number };
type DeploymentSelection = { namespace: string; name: string };
type CrdSelection = { name: string; version: string };
type ServiceDependency = {
  service: DeploymentSelection & { port: number };
  policy: DeploymentSelection;
  tls?: { secretName: string; serverName: string };
};
type WorkloadKind = "Deployment" | "StatefulSet";
type ClientCertificate = {
  workload: DeploymentSelection & { kind: WorkloadKind };
  container: string;
  certificatePath: string;
};

type PlanInput = {
  kubeconfig?: unknown;
  context?: unknown;
  namespace?: unknown;
  gatewayClass?: { name?: unknown; controllerName?: unknown };
  controllers?: { namespace?: unknown; name?: unknown }[];
  crds?: { name?: unknown; version?: unknown }[];
  apiCidrs?: unknown;
  serviceDependency?: unknown;
  clientCertificate?: unknown;
  peakAdditional?: Partial<Record<keyof PeakAdditional, unknown>>;
  eks?: { clusterArn?: unknown; webhookCidrs?: unknown };
};

type DiagnosticPlan = {
  kubeconfig: string;
  context: string;
  namespace: string;
  gatewayClass: { name: string; controllerName: string };
  controllers: DeploymentSelection[];
  crds: CrdSelection[];
  apiCidrs: string[];
  serviceDependency: ServiceDependency | undefined;
  clientCertificate: ClientCertificate | undefined;
  peakAdditional: PeakAdditional | undefined;
  eks:
    | {
        // Keep the original JSON value for strict comparison and reporting.
        clusterArn: unknown;
        webhookCidrs: string[];
        region: string;
        account: string;
        cluster: string;
      }
    | undefined;
};

type KubernetesMetadata = { uid?: string; generation?: number; deletionTimestamp?: string };
type NamedMetadata = KubernetesMetadata & {
  namespace?: string;
  name?: string;
  resourceVersion?: string;
};
type ResourceObservation = DeploymentSelection & {
  kind: "Service" | "NetworkPolicy" | "Secret" | WorkloadKind;
  uid: string;
  resourceVersion: string;
};
type Condition = { type: string; status: string; observedGeneration?: number };

type KubeConnection = {
  server: string;
  "tls-server-name"?: string;
  "certificate-authority-data"?: string;
  "insecure-skip-tls-verify"?: boolean;
};

type KubeconfigView = {
  clusters?: { cluster?: KubeConnection }[];
  users?: {
    user?: {
      token?: string;
      tokenFile?: string;
      exec?: { command?: string };
      "auth-provider"?: object;
      "client-certificate"?: string;
      "client-certificate-data"?: string;
      "client-key"?: string;
      "client-key-data"?: string;
      username?: string;
      password?: string;
    };
  }[];
};

type ApiService = {
  metadata?: NamedMetadata;
  spec: {
    type?: string;
    clusterIP: string;
    clusterIPs?: string[];
    selector?: Record<string, string>;
    ports?: { port: number; protocol?: string; targetPort?: number | string }[];
  };
};

type LabelSelector = { matchLabels?: Record<string, string>; matchExpressions?: unknown[] };
type EgressPeer = {
  ipBlock?: { cidr: string; except?: string[] };
  namespaceSelector?: LabelSelector;
  podSelector?: LabelSelector;
};
type NetworkPolicy = {
  metadata?: NamedMetadata;
  spec?: {
    podSelector?: LabelSelector;
    policyTypes?: string[];
    egress?: {
      to?: EgressPeer[];
      ports?: { protocol?: string; port?: number | string; endPort?: number }[];
    }[];
  };
};

type KubernetesList<T> = { metadata?: { continue?: string }; items: T[] };

type EndpointSlice = {
  addressType: string;
  endpoints: { addresses: string[] }[];
};

type CustomResourceDefinition = {
  metadata?: KubernetesMetadata;
  status?: { conditions?: Condition[] };
  spec?: { versions?: { name: string; served: boolean }[] };
};

type GatewayClass = {
  metadata?: KubernetesMetadata;
  status?: { conditions?: Condition[] };
  spec?: { controllerName?: string };
};

type DeploymentReadiness = {
  metadata: {
    uid: string | null;
    generation?: number | null;
    deletionTimestamp?: string | null;
  } | null;
  spec?: { replicas?: number | null } | null;
  status?: {
    conditions?: ({ type: string | null; status: string | null } | null)[] | null;
    observedGeneration?: number | null;
    updatedReplicas?: number | null;
    availableReplicas?: number | null;
    replicas?: number | null;
  } | null;
};

type ClientMount = {
  directoryPrefix: string;
  subPath: boolean | null;
  claim: boolean | null;
  volumes: ({
    secretName: string;
    optional: boolean | null;
    items: { key: string; path: string }[] | null;
  } | null)[];
};

type ClientWorkload = {
  apiVersion?: string;
  kind?: string;
  metadata?: NamedMetadata;
  mounts: (ClientMount | null)[] | null;
};

type MountedCertificateSecret = {
  name: string;
  requiredKeys: string[];
};

type ObservedTlsSecret = {
  metadata?: NamedMetadata;
  certificate: string;
  requiredKeysPresent?: boolean | null;
};

type QuotaResource = "count/jobs.batch" | "count/replicasets.apps";
type QuotaQuantities = Partial<Record<QuotaResource, string>>;

type ResourceQuota = {
  metadata: { name: string };
  spec: {
    hard: QuotaQuantities;
    scopes?: string[];
    scopeSelector?: { matchExpressions?: unknown[] };
  };
  status?: { hard?: QuotaQuantities; used?: QuotaQuantities };
};

type EksCluster = {
  endpoint: string;
  arn: string;
  name: string;
  certificateAuthority?: { data?: string };
  resourcesVpcConfig: { vpcId: string; clusterSecurityGroupId: string };
};

type NetworkInterfaces = {
  NextToken?: string;
  NetworkInterfaces: { PrivateIpAddresses: { PrivateIpAddress: string }[] }[];
};

type CheckStatus = "passed" | "failed" | "unknown";
type QuotaLimit = {
  quota: string;
  resource: QuotaResource;
  additional: number | undefined;
} & ({ status: "unknown" } | { status: "passed" | "failed"; hard: string; used: string });

type CheckResult = {
  status: CheckStatus;
  summary: string;
  resource?: string;
  missing?: string[];
  stale?: string[];
  limits?: QuotaLimit[];
  resources?: ResourceObservation[];
};

type CheckReport = CheckResult & { id: string; action?: string };
type DiagnosticReport = {
  expectedClusterArn?: unknown;
  context: string;
  namespace: string;
  checkedAt: string;
  checks: CheckReport[];
  limits: string[];
};

class DiagnosticError extends Error {}
const namePattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?![\s\S])/;

function isDnsName(value: string): boolean {
  return value.length <= 253 && value.split(".").every((part) => dnsLabel.test(part));
}

function isObject(value: unknown, fields?: string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (!fields || Object.keys(value).every((key) => fields.includes(key)))
  );
}

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function requireName(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > 253 || !namePattern.test(value)) {
    throw new DiagnosticError(`${field} must be a Kubernetes resource name`);
  }
  return value;
}

function requireCidrs(value: unknown, field: string): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (cidr: unknown) =>
        typeof cidr !== "string" || !cidr.endsWith("/32") || isIP(cidr.slice(0, -3)) !== 4,
    )
  ) {
    throw new DiagnosticError(`${field} must contain explicit IPv4 /32 CIDRs`);
  }
}

function requireSelection(value: unknown, field: "kubeconfig" | "context"): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DiagnosticError(`${field} is required`);
  }
  return value;
}

function requirePeakCount(count: unknown): number {
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new DiagnosticError(
      "peakAdditional must specify nonnegative integer jobs and replicaSets",
    );
  }
  return count;
}

function serviceDependency(value: unknown): ServiceDependency | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isObject(value, ["service", "policy", "tls"])) {
    throw new DiagnosticError("serviceDependency accepts only service, policy and tls");
  }
  const { service, policy, tls } = value;
  if (!isObject(service, ["namespace", "name", "port"])) {
    throw new DiagnosticError("serviceDependency.service must specify namespace, name and port");
  }
  if (!isObject(policy, ["namespace", "name"])) {
    throw new DiagnosticError("serviceDependency.policy must specify namespace and name");
  }
  const serviceName = requireName(service.name, "serviceDependency.service.name");
  const serviceNamespace = requireName(service.namespace, "serviceDependency.service.namespace");
  const policyName = requireName(policy.name, "serviceDependency.policy.name");
  const policyNamespace = requireName(policy.namespace, "serviceDependency.policy.namespace");
  if (
    ![serviceName, serviceNamespace, policyNamespace].every((name) => dnsLabel.test(name)) ||
    !isDnsName(policyName)
  ) {
    throw new DiagnosticError(
      "serviceDependency requires valid Service, namespace and NetworkPolicy names",
    );
  }
  if (!isPort(service.port)) {
    throw new DiagnosticError(
      "serviceDependency.service.port must be a TCP port from 1 through 65535",
    );
  }
  const selection: ServiceDependency = {
    service: { namespace: serviceNamespace, name: serviceName, port: service.port },
    policy: { namespace: policyNamespace, name: policyName },
  };
  if (tls !== undefined) {
    if (!isObject(tls, ["secretName", "serverName"])) {
      throw new DiagnosticError("serviceDependency.tls must specify secretName and serverName");
    }
    const secretName = requireName(tls.secretName, "serviceDependency.tls.secretName");
    const serverName = typeof tls.serverName === "string" ? tls.serverName.toLowerCase() : "";
    if (!isDnsName(secretName) || !isDnsName(serverName) || isIP(serverName)) {
      throw new DiagnosticError(
        "serviceDependency.tls requires a Secret name and a DNS serverName",
      );
    }
    selection.tls = { secretName, serverName };
  }
  return selection;
}

function clientCertificate(value: unknown): ClientCertificate | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isObject(value, ["workload", "container", "certificatePath"])) {
    throw new DiagnosticError(
      "clientCertificate accepts only workload, container and certificatePath",
    );
  }
  const { workload, container, certificatePath } = value;
  if (!isObject(workload, ["kind", "name", "namespace"])) {
    throw new DiagnosticError("clientCertificate.workload must specify kind, name and namespace");
  }
  const { kind, name, namespace } = workload;
  if (
    (kind !== "Deployment" && kind !== "StatefulSet") ||
    typeof name !== "string" ||
    !isDnsName(name) ||
    typeof namespace !== "string" ||
    !dnsLabel.test(namespace) ||
    typeof container !== "string" ||
    !dnsLabel.test(container)
  ) {
    throw new DiagnosticError(
      "clientCertificate requires a named Deployment or StatefulSet and container",
    );
  }
  if (
    typeof certificatePath !== "string" ||
    certificatePath.length > 1024 ||
    !/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+(?![\s\S])/u.test(certificatePath) ||
    posix.normalize(certificatePath) !== certificatePath
  ) {
    throw new DiagnosticError(
      "clientCertificate.certificatePath must be a normalized absolute file path",
    );
  }
  return { workload: { kind, name, namespace }, container, certificatePath };
}

function validateConfig(value: unknown): DiagnosticPlan {
  if (
    !isObject(value, [
      "kubeconfig",
      "context",
      "namespace",
      "gatewayClass",
      "controllers",
      "crds",
      "apiCidrs",
      "serviceDependency",
      "clientCertificate",
      "peakAdditional",
      "eks",
    ])
  ) {
    throw new DiagnosticError(
      "The plan must be a JSON object with only supported top-level fields.",
    );
  }
  const config = value as PlanInput;
  const kubeconfig = requireSelection(config.kubeconfig, "kubeconfig");
  const context = requireSelection(config.context, "context");
  const namespace = requireName(config.namespace, "namespace");
  const gatewayName = requireName(config.gatewayClass?.name, "gatewayClass.name");
  const controllerName = config.gatewayClass?.controllerName;
  if (typeof controllerName !== "string" || !controllerName.includes("/")) {
    throw new DiagnosticError("gatewayClass.controllerName is required");
  }
  if (
    !Array.isArray(config.controllers) ||
    config.controllers.length === 0 ||
    config.controllers.length > 20
  ) {
    throw new DiagnosticError("controllers must select between one and twenty Deployments");
  }
  const controllers = config.controllers.map((controller) => ({
    namespace: requireName(controller.namespace, "controllers.namespace"),
    name: requireName(controller.name, "controllers.name"),
  }));
  if (!Array.isArray(config.crds) || config.crds.length === 0 || config.crds.length > 20) {
    throw new DiagnosticError("crds must select between one and twenty required CRDs");
  }
  const crds = config.crds.map((crd) => ({
    name: requireName(crd.name, "crds.name"),
    version: requireName(crd.version, "crds.version"),
  }));
  const apiCidrs = config.apiCidrs;
  requireCidrs(apiCidrs, "apiCidrs");
  let peakAdditional: PeakAdditional | undefined;
  if (config.peakAdditional !== undefined) {
    peakAdditional = {
      jobs: requirePeakCount(config.peakAdditional?.jobs),
      replicaSets: requirePeakCount(config.peakAdditional?.replicaSets),
    };
  }
  let eks: DiagnosticPlan["eks"];
  if (config.eks !== undefined) {
    const { clusterArn, webhookCidrs } = config.eks;
    const arn =
      /^arn:(aws|aws-us-gov|aws-cn):eks:([a-z0-9-]+):(\d{12}):cluster\/([A-Za-z0-9][A-Za-z0-9_-]{0,99})$/.exec(
        String(clusterArn ?? ""),
      );
    const [, , region, account, cluster] = arn ?? [];
    if (!region || !account || !cluster) {
      throw new DiagnosticError("eks.clusterArn must identify the intended EKS cluster");
    }
    requireCidrs(webhookCidrs, "eks.webhookCidrs");
    eks = { clusterArn, webhookCidrs, region, account, cluster };
  }
  return {
    kubeconfig,
    context,
    namespace,
    gatewayClass: { name: gatewayName, controllerName },
    controllers,
    crds,
    apiCidrs,
    serviceDependency: serviceDependency(config.serviceDependency),
    clientCertificate: clientCertificate(config.clientCertificate),
    peakAdditional,
    eks,
  };
}

// A credential plugin can inherit its parent's pipes. Bound both the wait and the
// captured bytes even when the CLI or a descendant never closes those pipes.
async function commandOutput(
  command: string,
  args: string[],
  deadline: number,
  stderrMode: "classify" | "discard" = "classify",
): Promise<string> {
  const timeout = Math.min(20_000, deadline - performance.now());
  if (timeout <= 0) {
    throw new DiagnosticError("The collection deadline expired.");
  }
  const grouped = process.platform !== "win32";
  const child = spawn(command, args, {
    detached: grouped,
    stdio: ["ignore", "pipe", stderrMode === "discard" ? "ignore" : "pipe"],
    env: { ...process.env, KUBECTL_KUBERC: "false", AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off" },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let size = 0;
  const result = await new Promise<number | null>((resolve, reject) => {
    function stop(reason: string) {
      if (grouped && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
            child.kill("SIGKILL");
          }
        }
      } else {
        child.kill("SIGKILL");
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      reject(new DiagnosticError(reason));
    }
    const timer = setTimeout(() => stop("The selected command exceeded its deadline."), timeout);
    for (const [stream, output] of [
      [child.stdout, stdout],
      [child.stderr, stderr],
    ] as const) {
      stream?.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          stop("The read exceeded the output limit.");
        } else {
          output.push(chunk);
        }
      });
    }
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        new DiagnosticError(
          error.code === "ENOENT"
            ? "A required command is not installed."
            : "The command could not start.",
        ),
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  if (result !== 0) {
    if (stderrMode === "discard") {
      throw new DiagnosticError(
        "The named resource could not be read. Verify it exists and the selected identity has get access.",
      );
    }
    const text = Buffer.concat(stderr).toString();
    let reason = "The read failed or returned incomplete data.";
    if (/Forbidden|forbidden|AccessDenied|UnauthorizedOperation/.test(text)) {
      reason = "The selected identity is not authorized to read this resource.";
    } else if (/Unauthorized|must be logged in|ExpiredToken|InvalidClientTokenId/.test(text)) {
      reason = "The selected credentials could not authenticate.";
    } else if (/x509:|certificate|TLS handshake error/.test(text)) {
      reason = "The selected endpoint's TLS connection could not be verified.";
    } else if (
      /connection refused|no route to host|timeout|context deadline exceeded|no such host|Unable to connect to the server/i.test(
        text,
      )
    ) {
      reason = "The selected endpoint could not be reached.";
    }
    throw new DiagnosticError(reason);
  }
  return Buffer.concat(stdout).toString().trim();
}

function parseJson<T>(output: string): T {
  // Callers project only the fields they inspect. Keep incomplete or malformed
  // observations subject to each check's existing tests and error handling.
  const parsed: unknown = output ? JSON.parse(output) : null;
  return parsed as T;
}

async function jsonCommand<T>(command: string, args: string[], deadline: number): Promise<T> {
  return parseJson<T>(await commandOutput(command, args, deadline));
}

function observeResource(
  kind: ResourceObservation["kind"],
  selection: DeploymentSelection,
  metadata: NamedMetadata | undefined,
): ResourceObservation {
  if (
    metadata?.namespace !== selection.namespace ||
    metadata.name !== selection.name ||
    typeof metadata.uid !== "string" ||
    metadata.uid.length === 0 ||
    typeof metadata.resourceVersion !== "string" ||
    metadata.resourceVersion.length === 0
  ) {
    throw new DiagnosticError(
      "The response lacks the selected resource identity or resourceVersion.",
    );
  }
  return {
    kind,
    namespace: selection.namespace,
    name: selection.name,
    uid: metadata.uid,
    resourceVersion: metadata.resourceVersion,
  };
}

function unreadable(error: unknown): CheckResult {
  // Provider errors can contain credential-plugin output or private endpoints.
  return {
    status: "unknown",
    summary:
      error instanceof DiagnosticError
        ? error.message
        : "The read failed or returned incomplete data.",
  };
}

function exactLabels(selector: LabelSelector | undefined, labels: Record<string, string>): boolean {
  return (
    isDeepStrictEqual(selector?.matchLabels, labels) &&
    (selector?.matchExpressions === undefined || selector.matchExpressions.length === 0)
  );
}

async function serviceEgress(
  selection: ServiceDependency,
  service: ApiService | null,
  readPolicy: () => Promise<NetworkPolicy | null>,
): Promise<CheckResult> {
  if (service === null) {
    return { status: "failed", summary: "The selected Service does not exist." };
  }
  const resources = [observeResource("Service", selection.service, service.metadata)];
  if (service.metadata?.deletionTimestamp) {
    return {
      status: "failed",
      summary: "The selected Service is terminating.",
      resources,
    };
  }
  const spec = service.spec;
  if (!spec || !Array.isArray(spec.ports)) {
    throw new DiagnosticError("The response lacks a complete Service spec.");
  }
  const addresses = spec.clusterIPs ?? (spec.type === "ExternalName" ? [] : [spec.clusterIP]);
  if (
    !Array.isArray(addresses) ||
    addresses.some(
      (address) => address !== "None" && (typeof address !== "string" || !isIP(address)),
    )
  ) {
    throw new DiagnosticError("The response lacks a complete Service address inventory.");
  }
  const ipv4 = addresses.filter((address) => isIP(address) === 4);
  const ports = spec.ports.filter(
    ({ port, protocol = "TCP" }) => port === selection.service.port && protocol === "TCP",
  );
  if (
    ipv4.length !== 1 ||
    ports.length !== 1 ||
    !spec.selector ||
    Object.keys(spec.selector).length === 0
  ) {
    return {
      status: "failed",
      summary:
        "The selected Service must have one IPv4 ClusterIP, the selected TCP port and a Pod selector.",
      resources,
    };
  }
  const { selector } = spec;
  if (!isObject(selector) || Object.values(selector).some((value) => typeof value !== "string")) {
    throw new DiagnosticError("The response lacks a valid Service Pod selector.");
  }
  const cidr = `${ipv4[0]}/32`;
  const targetPort = ports[0]?.targetPort ?? selection.service.port;
  if (!isPort(targetPort) && (typeof targetPort !== "string" || !targetPort.length)) {
    throw new DiagnosticError("The response lacks a valid Service target port.");
  }
  const policy = await readPolicy();
  if (policy === null) {
    return {
      status: "failed",
      summary: "The selected NetworkPolicy does not exist.",
      resources,
    };
  }
  resources.push(observeResource("NetworkPolicy", selection.policy, policy.metadata));
  if (policy.metadata?.deletionTimestamp) {
    return {
      status: "failed",
      summary: "The selected NetworkPolicy is terminating.",
      resources,
    };
  }
  const policySpec = policy.spec;
  if (!isObject(policySpec?.podSelector) || !Array.isArray(policySpec.policyTypes)) {
    throw new DiagnosticError("The response lacks a complete NetworkPolicy spec.");
  }
  const rules = policySpec.policyTypes.includes("Egress") ? (policySpec.egress ?? []) : [];
  if (!Array.isArray(rules)) {
    throw new DiagnosticError("The response lacks a complete NetworkPolicy egress ruleset.");
  }
  // Match each peer and its port inside one rule, as rendered by service_edges.
  const grants = (port: number | string, matches: (peer: EgressPeer) => boolean) =>
    rules.some(
      (rule) =>
        rule.ports?.some(
          (entry) =>
            (entry.protocol ?? "TCP") === "TCP" &&
            entry.port === port &&
            (entry.endPort === undefined || entry.endPort === port),
        ) && rule.to?.some(matches),
    );
  const serviceGrant = grants(
    selection.service.port,
    (peer) =>
      peer.ipBlock?.cidr === cidr &&
      !peer.ipBlock.except?.length &&
      peer.namespaceSelector === undefined &&
      peer.podSelector === undefined,
  );
  const podGrant = grants(
    targetPort,
    (peer) =>
      peer.ipBlock === undefined &&
      exactLabels(peer.namespaceSelector, {
        "kubernetes.io/metadata.name": selection.service.namespace,
      }) &&
      exactLabels(peer.podSelector, selector),
  );
  const missing = [
    ...(!serviceGrant ? [`${cidr} TCP/${selection.service.port}`] : []),
    ...(!podGrant
      ? [`${selection.service.namespace} Service-selected Pods TCP/${targetPort}`]
      : []),
  ];
  return {
    status: missing.length ? "failed" : "passed",
    summary: missing.length
      ? "The selected NetworkPolicy lacks a required Service egress grant."
      : "The selected NetworkPolicy has both required Service egress grants.",
    missing,
    resources,
  };
}

// Guard the traversal and print only scalar leaves. On a template execution
// error kubectl's Go-template printer can dump the original object to stdout.
const observationTemplates = `
{{define "text"}}{{if eq (printf "%T" .) "string"}}{{printf "%q" .}}{{else}}""{{end}}{{end}}
{{define "nullableText"}}{{if eq (printf "%T" .) "string"}}{{printf "%q" .}}{{else}}null{{end}}{{end}}
{{define "identity"}}
  {{if eq (printf "%T" .) "map[string]interface {}"}}
    {"name":{{template "text" .name}},"namespace":{{template "text" .namespace}},
     "uid":{{template "text" .uid}},"resourceVersion":{{template "text" .resourceVersion}},
     "deletionTimestamp":{{template "text" .deletionTimestamp}}}
  {{else}}null{{end}}
{{end}}
`;

function clientWorkloadProjection({
  container,
  certificatePath,
  workload: { kind, namespace, name },
}: ClientCertificate): string {
  return `${observationTemplates}
{{define "items"}}
  {{if eq (printf "%T" .) "[]interface {}"}}
    [{{range $i, $item := .}}{{if $i}},{{end}}
      {{if eq (printf "%T" $item) "map[string]interface {}"}}
        {"key":{{template "text" $item.key}},"path":{{template "text" $item.path}}}
      {{else}}null{{end}}
    {{end}}]
  {{else if eq (printf "%T" .) "<nil>"}}[]{{else}}null{{end}}
{{end}}
{{define "secretVolume"}}
  {{if eq (printf "%T" .) "map[string]interface {}"}}
    {"secretName":{{template "text" .secretName}},"items":{{template "items" .items}},
     "optional":{{if eq (printf "%T" .optional) "bool"}}{{.optional}}
                 {{else if eq (printf "%T" .optional) "<nil>"}}false{{else}}null{{end}}}
  {{else}}null{{end}}
{{end}}
{{- define "clientMounts" -}}
  {{- $certificatePath := ${JSON.stringify(certificatePath)} -}}
  {{- $spec := .spec -}}
  {{- $pod := .spec.template.spec -}}
  {{- $container := $pod -}}
  {{- $found := false -}}
  {{- $duplicate := false -}}
  {{- $valid := eq (printf "%T" $pod.containers) "[]interface {}" -}}
  {{- range $field, $containers := $pod -}}
    {{- if or (eq $field "containers") (eq $field "initContainers") -}}
      {{- if eq (printf "%T" $containers) "[]interface {}" -}}
        {{- range $entry := $containers -}}
          {{- if ne (printf "%T" $entry) "map[string]interface {}" -}}
            {{- $valid = false -}}
          {{- else if and (eq (printf "%T" $entry.name) "string") (eq $entry.name ${JSON.stringify(container)})
                     (or (eq $field "containers")
                         (and (eq (printf "%T" $entry.restartPolicy) "string") (eq $entry.restartPolicy "Always"))) -}}
            {{- $duplicate = $found -}}
            {{- $found = true -}}
            {{- $container = $entry -}}
          {{- end -}}
        {{- end -}}
      {{- else if ne (printf "%T" $containers) "<nil>" -}}
        {{- $valid = false -}}
      {{- end -}}
    {{- end -}}
  {{- end -}}
  {{- if not $valid -}}null
  {{- else if or (not $found) $duplicate -}}[]
  {{- else -}}
    {{- $mount := $container -}}
    {{- $foundMount := false -}}
    {{- $overlap := false -}}
    {{- $validPaths := true -}}
    {{- $directoryPrefix := "" -}}
    {{- if eq (printf "%T" $container.volumeMounts) "[]interface {}" -}}
      {{- range $candidate := $container.volumeMounts -}}
        {{- if not (and (eq (printf "%T" $candidate) "map[string]interface {}")
                     (eq (printf "%T" $candidate.name) "string") $candidate.name
                     (eq (printf "%T" $candidate.mountPath) "string") $candidate.mountPath
                     (eq (index $candidate.mountPath 0) '/')) -}}
          {{- $validPaths = false -}}
          {{- break -}}
        {{- end -}}
        {{/* Clean POSIX segments in kubectl to find shadow mounts without emitting unrelated paths. */}}
        {{- $raw := printf "%s/" $candidate.mountPath -}}
        {{- $normalized := "" -}}
        {{- $start := 0 -}}
        {{- range $end := len $raw -}}
          {{- if eq (index $raw $end) '/' -}}
            {{- $segment := slice $raw $start $end -}}
            {{- if eq $segment "/.." -}}
              {{- $last := 0 -}}
              {{- range $i := len $normalized -}}
                {{- if eq (index $normalized $i) '/' -}}{{- $last = $i -}}{{- end -}}
              {{- end -}}
              {{- $normalized = slice $normalized 0 $last -}}
            {{- else if and $segment (ne $segment "/.") (ne $segment "/") -}}
              {{- $normalized = printf "%s%s" $normalized $segment -}}
            {{- end -}}
            {{- $start = $end -}}
          {{- end -}}
        {{- end -}}
        {{- $prefix := printf "%s/" $normalized -}}
        {{- if or (eq $certificatePath $normalized)
                   (and (le (len $prefix) (len $certificatePath))
                        (eq $prefix (slice $certificatePath 0 (len $prefix)))) -}}
          {{- $overlap = $foundMount -}}
          {{- $foundMount = true -}}
          {{- $mount = $candidate -}}
          {{- $directoryPrefix = $prefix -}}
        {{- end -}}
      {{- end -}}
    {{- else if ne (printf "%T" $container.volumeMounts) "<nil>" -}}
      {{- $validPaths = false -}}
    {{- end -}}
    {{- if not $validPaths -}}[null]
    {{- else if or (not $foundMount) $overlap -}}[]
    {{- else -}}
        [{"directoryPrefix":{{template "text" $directoryPrefix}},
         "subPath":{{- $subPath := "false" -}}
           {{- range $field, $value := $mount -}}
             {{- if or (eq $field "subPath") (eq $field "subPathExpr") -}}
               {{- if ne (printf "%T" $value) "string" -}}{{- $subPath = "null" -}}
               {{- else if and (ne $subPath "null") $value -}}{{- $subPath = "true" -}}{{- end -}}
             {{- end -}}
           {{- end -}}{{- $subPath -}},
         "claim":{{- $claim := "false" -}}
           {{- if and (eq (printf "%T" $.kind) "string") (eq $.kind "StatefulSet") -}}
             {{- range $field, $claims := $spec -}}
               {{- if eq $field "volumeClaimTemplates" -}}
                 {{- if eq (printf "%T" $claims) "[]interface {}" -}}
                   {{- range $entry := $claims -}}
                     {{- if not (and (eq (printf "%T" $entry) "map[string]interface {}")
                                  (eq (printf "%T" $entry.metadata) "map[string]interface {}")
                                  (eq (printf "%T" $entry.metadata.name) "string") $entry.metadata.name) -}}
                       {{- $claim = "null" -}}
                     {{- else if and (ne $claim "null") (eq $entry.metadata.name $mount.name) -}}
                       {{- $claim = "true" -}}
                     {{- end -}}
                   {{- end -}}
                 {{- else -}}{{- $claim = "null" -}}{{- end -}}
               {{- end -}}
             {{- end -}}
           {{- end -}}{{- $claim -}},
         "volumes":[
           {{- $volumeSeparator := "" -}}
           {{- if and (eq $subPath "false") (eq $claim "false") (eq (printf "%T" $pod.volumes) "[]interface {}") -}}
             {{- range $volume := $pod.volumes -}}
               {{- if and (eq (printf "%T" $volume) "map[string]interface {}")
                         (eq (printf "%T" $volume.name) "string") (eq $volume.name $mount.name) -}}
                 {{- $volumeSeparator -}}{{- $volumeSeparator = "," -}}{{- template "secretVolume" $volume.secret -}}
               {{- end -}}
             {{- end -}}
           {{- end -}}]}]
    {{- end -}}
  {{- end -}}
{{- end -}}
{"apiVersion":{{template "text" .apiVersion}},"kind":{{template "text" .kind}},
 "metadata":{{template "identity" .metadata}},
 "mounts":{{if and (eq (printf "%T" .apiVersion) "string") (eq .apiVersion "apps/v1")
                   (eq (printf "%T" .kind) "string") (eq .kind ${JSON.stringify(kind)})
                   (eq (printf "%T" .metadata) "map[string]interface {}")
                   (eq (printf "%T" .metadata.name) "string") (eq .metadata.name ${JSON.stringify(name)})
                   (eq (printf "%T" .metadata.namespace) "string") (eq .metadata.namespace ${JSON.stringify(namespace)})
                   (eq (printf "%T" .metadata.uid) "string") .metadata.uid
                   (eq (printf "%T" .metadata.resourceVersion) "string") .metadata.resourceVersion
                   (eq (printf "%T" .spec) "map[string]interface {}")
                   (eq (printf "%T" .spec.template) "map[string]interface {}")
                   (eq (printf "%T" .spec.template.spec) "map[string]interface {}")}}
   {{template "clientMounts" .}}
 {{else}}null{{end}}
}
`;
}

const deploymentReadinessProjection = `${observationTemplates}
{{define "number"}}
  {{if or (eq (printf "%T" .) "int64") (eq (printf "%T" .) "float64")}}{{.}}{{else}}null{{end}}
{{end}}
{{define "rolloutConditions"}}
  {{if eq (printf "%T" .) "[]interface {}"}}
    [{{range $i, $condition := .}}{{if $i}},{{end}}
       {{if eq (printf "%T" $condition) "map[string]interface {}"}}
         {"type":{{template "nullableText" $condition.type}},"status":{{template "nullableText" $condition.status}}}
       {{else}}null{{end}}
    {{end}}]
  {{else}}null{{end}}
{{end}}
{"metadata":{{if eq (printf "%T" .metadata) "map[string]interface {}"}}
                {"uid":{{template "nullableText" .metadata.uid}}
                  {{range $field, $value := .metadata}}{{if ne (printf "%T" $value) "<nil>"}}
                    {{if eq $field "generation"}},"generation":{{template "number" $value}}{{end}}
                    {{if eq $field "deletionTimestamp"}},"deletionTimestamp":{{template "nullableText" $value}}{{end}}
                  {{end}}{{end}}}
              {{else}}null{{end}}
 {{range $field, $value := .}}{{if ne (printf "%T" $value) "<nil>"}}
   {{if eq $field "spec"}}
     ,"spec":{{if eq (printf "%T" $value) "map[string]interface {}"}}
       { {{range $key, $count := $value}}{{if and (eq $key "replicas") (ne (printf "%T" $count) "<nil>")}}"replicas":{{template "number" $count}}{{end}}{{end}} }
       {{else}}null{{end}}
   {{end}}
   {{if eq $field "status"}}
     ,"status":{{if eq (printf "%T" $value) "map[string]interface {}"}}
       { {{$separator := ""}}
         {{range $key, $fieldValue := $value}}{{if ne (printf "%T" $fieldValue) "<nil>"}}
           {{if or (eq $key "observedGeneration") (eq $key "updatedReplicas") (eq $key "availableReplicas") (eq $key "replicas")}}
             {{$separator}}{{printf "%q" $key}}:{{template "number" $fieldValue}}{{$separator = ","}}
           {{else if eq $key "conditions"}}
             {{$separator}}"conditions":{{template "rolloutConditions" $fieldValue}}{{$separator = ","}}
           {{end}}
         {{end}}{{end}} }
       {{else}}null{{end}}
   {{end}}
 {{end}}{{end}}}
`;

const tlsSecretFields = `${observationTemplates}
{"metadata":{{template "identity" .metadata}},
 "certificate":{{if exists . "data" "tls.crt"}}{{template "text" (index .data "tls.crt")}}{{else}}""{{end}}`;

function requiredSecretKeysProjection(requiredKeys: string[]): string {
  if (!requiredKeys.length) {
    return "";
  }
  const presence = requiredKeys.map((key) => `(exists .data ${JSON.stringify(key)})`).join(" ");
  return `,
 "requiredKeysPresent":{{if eq (printf "%T" .data) "map[string]interface {}"}}
   {{and ${presence}}}
 {{else if eq (printf "%T" .data) "<nil>"}}false{{else}}null{{end}}`;
}

function inspectCertificate(
  selection: DeploymentSelection,
  output: string,
  serverName?: string,
  requiredKeys: string[] = [],
): CheckResult {
  const secret = parseJson<ObservedTlsSecret | null>(output);
  if (!secret) {
    return { status: "failed", summary: "The selected TLS Secret does not exist." };
  }
  const resources = [observeResource("Secret", selection, secret.metadata)];
  const failure = (summary: string): CheckResult => ({ status: "failed", summary, resources });
  if (secret.metadata?.deletionTimestamp) {
    return failure("The selected TLS Secret is terminating.");
  }
  const { certificate, requiredKeysPresent } = secret;
  if (requiredKeys.length) {
    if (typeof requiredKeysPresent !== "boolean") {
      return {
        status: "unknown",
        summary:
          "The response did not establish whether the selected TLS Secret has the required keys.",
        resources,
      };
    }
    if (!requiredKeysPresent) {
      return failure("The selected Secret volume maps a required key that the Secret lacks.");
    }
  }
  const bytes = Buffer.from(certificate, "base64");
  const pem = bytes
    .toString("utf8")
    .match(/^\s*(-----BEGIN CERTIFICATE-----\s[\s\S]+?-----END CERTIFICATE-----)/u)?.[1];
  let leaf: X509Certificate;
  try {
    if (!pem || bytes.toString("base64") !== certificate) {
      throw new Error("invalid leaf");
    }
    leaf = new X509Certificate(pem);
  } catch {
    return failure("The selected TLS Secret lacks a readable X.509 leaf in tls.crt.");
  }
  const now = Date.now();
  const notBefore = leaf.validFromDate.getTime();
  const notAfter = leaf.validToDate.getTime();
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) {
    return failure("The selected TLS leaf has an unreadable validity window.");
  }
  if (now < notBefore) {
    return failure("The selected TLS leaf is not yet valid.");
  }
  if (now > notAfter) {
    return failure("The selected TLS leaf has expired.");
  }
  if (
    serverName !== undefined &&
    !leaf.checkHost(serverName, { subject: "never", partialWildcards: false })
  ) {
    return failure("The selected TLS leaf lacks a DNS SAN matching the expected serverName.");
  }
  if (serverName === undefined) {
    const usages = leaf.keyUsage;
    // Node reports undefined for both absent and undecodable extensions.
    if (usages === undefined) {
      return {
        status: "unknown",
        summary:
          "The mounted TLS leaf is current. Its extended key usage does not establish client authentication suitability.",
        resources,
      };
    }
    if (!usages.includes("1.3.6.1.5.5.7.3.2") && !usages.includes("2.5.29.37.0")) {
      return failure(
        "The selected TLS leaf's extended key usage does not permit client authentication.",
      );
    }
  }
  return {
    status: "passed",
    summary:
      serverName === undefined
        ? "The mounted TLS leaf is within its validity window and its extended key usage permits client use."
        : "The selected TLS leaf is within its validity window and has a matching DNS SAN.",
    resources,
  };
}

function mountedClientSecret(
  selection: ClientCertificate,
  observed: ClientWorkload,
): MountedCertificateSecret | undefined {
  const { mounts } = observed;
  if (!Array.isArray(mounts)) {
    throw new DiagnosticError("The selected workload response lacks its Pod template containers.");
  }
  if (mounts.includes(null)) {
    throw new DiagnosticError("The response lacks valid mount paths in the selected container.");
  }
  const [mount] = mounts;
  if (mounts.length !== 1 || !mount) {
    return undefined;
  }
  if (mount.subPath === null) {
    throw new DiagnosticError("The selected volume mount has an invalid subpath.");
  }
  if (mount.subPath) {
    return undefined;
  }
  // The StatefulSet controller gives claims precedence over same-name Pod volumes.
  if (mount.claim === null) {
    throw new DiagnosticError("The response lacks a valid StatefulSet volume claim inventory.");
  }
  if (mount.claim) {
    return undefined;
  }
  const path = selection.certificatePath;
  const prefix = mount.directoryPrefix;
  if (!path.startsWith(prefix)) {
    return undefined;
  }

  const secret = mount.volumes.length === 1 ? mount.volumes[0] : undefined;
  if (!secret || typeof secret.secretName !== "string" || !isDnsName(secret.secretName)) {
    return undefined;
  }
  if (secret.optional === null || !Array.isArray(secret.items)) {
    throw new DiagnosticError("The response lacks the selected Secret volume's item mapping.");
  }
  const file = path.slice(prefix.length);
  if (secret.items.length) {
    const keys: string[] = [];
    for (const { key, path: target } of secret.items) {
      if (typeof key !== "string" || !/^[A-Za-z0-9_.-]{1,253}(?![\s\S])/u.test(key)) {
        throw new DiagnosticError("The selected Secret volume has an invalid item key.");
      }
      // Match what the volume writer resolves, including "./" and repeated slashes.
      if (
        !target ||
        posix.isAbsolute(target) ||
        target.startsWith("..") ||
        target.split("/").includes("..")
      ) {
        return undefined;
      }
      const resolved = posix.normalize(target).replace(/\/$/u, "");
      if (
        resolved === "." ||
        resolved.startsWith("..") ||
        resolved.startsWith(`${file}/`) ||
        file.startsWith(`${resolved}/`)
      ) {
        return undefined;
      }
      if (resolved === file) {
        keys.push(key);
      }
    }
    if (keys.length !== 1 || keys[0] !== "tls.crt") {
      return undefined;
    }
    return {
      name: secret.secretName,
      requiredKeys: secret.optional ? [] : secret.items.map(({ key }) => key),
    };
  }
  return file === "tls.crt" ? { name: secret.secretName, requiredKeys: [] } : undefined;
}

function quantity(value: unknown) {
  if (typeof value !== "string" || value.length > 100) {
    return undefined;
  }
  const match = /^(\d+)(?:\.(\d+))?(n|u|m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei|[eE][+-]?\d+)?$/.exec(
    value,
  );
  if (!match) {
    return undefined;
  }
  const decimal: Record<string, number> = {
    n: -9,
    u: -6,
    m: -3,
    k: 3,
    M: 6,
    G: 9,
    T: 12,
    P: 15,
    E: 18,
  };
  const binary: Record<string, number> = { Ki: 10, Mi: 20, Gi: 30, Ti: 40, Pi: 50, Ei: 60 };
  const suffix = match[3] ?? "";
  let exponent = 0;
  const decimalExponent = decimal[suffix];
  if (decimalExponent !== undefined) {
    exponent = decimalExponent;
  } else if (/^[eE]/.test(suffix) && suffix !== "E") {
    exponent = Number(suffix.slice(1));
  }
  if (Math.abs(exponent) > 100) {
    return undefined;
  }
  const digits = match[2] ?? "";
  const binaryExponent = binary[suffix];
  return {
    text: value,
    numerator:
      BigInt(match[1] + digits) *
      (binaryExponent === undefined
        ? 10n ** BigInt(Math.max(0, exponent))
        : 2n ** BigInt(binaryExponent)),
    denominator: 10n ** BigInt(digits.length + Math.max(0, -exponent)),
  };
}

async function diagnose(
  config: DiagnosticPlan,
  directory: string | undefined,
): Promise<DiagnosticReport> {
  const deadline = performance.now() + 120_000;
  let transport: string[] = [];
  const checks: CheckReport[] = [];
  let kubeUnavailable: string | undefined;
  const kubectl = (args: string[], stderrMode?: "discard") => {
    if (kubeUnavailable) {
      throw new DiagnosticError(kubeUnavailable);
    }
    return commandOutput(
      "kubectl",
      [
        "--kubeconfig",
        config.kubeconfig,
        "--context",
        config.context,
        "--request-timeout=15s",
        ...transport,
        ...args,
      ],
      deadline,
      stderrMode,
    );
  };
  const kubeOutput = (...args: string[]) => kubectl(args);
  const kube = async <T>(...args: string[]) => parseJson<T>(await kubeOutput(...args));
  const getNamed = <T>(kind: string, { namespace, name }: DeploymentSelection) =>
    kube<T | null>("-n", namespace, "get", kind, name, "--ignore-not-found", "-o", "json");
  // Refusals and diagnostics from sensitive GETs can contain API-supplied text.
  const projectNamed = (
    kind: string,
    { namespace, name }: DeploymentSelection,
    projection: string,
  ) =>
    kubectl(
      [
        "-n",
        namespace,
        "get",
        kind,
        name,
        "--ignore-not-found",
        "--v=0",
        "-o",
        `go-template=${projection}`,
      ],
      "discard",
    );
  const readCertificate = async (
    selection: DeploymentSelection,
    serverName?: string,
    requiredKeys: string[] = [],
  ) =>
    inspectCertificate(
      selection,
      await projectNamed(
        "secret",
        selection,
        `${tlsSecretFields}${requiredSecretKeysProjection(requiredKeys)}}`,
      ),
      serverName,
      requiredKeys,
    );
  async function check(
    id: string,
    action: string,
    inspect: () => Promise<CheckResult>,
  ): Promise<CheckResult> {
    let result: CheckResult;
    try {
      result = await inspect();
    } catch (error) {
      result = unreadable(error);
    }
    checks.push({ id, ...result, ...(result.status === "passed" ? {} : { action }) });
    return result;
  }
  function comparison(expected: string[], actual: string[]): CheckResult {
    const observed = new Set(actual);
    const configured = new Set(expected);
    const missing = [...observed].filter((cidr) => !configured.has(cidr)).sort();
    const stale = [...configured].filter((cidr) => !observed.has(cidr)).sort();
    return {
      status: missing.length || stale.length ? "failed" : "passed",
      summary:
        missing.length || stale.length
          ? "Configured addresses differ from the current inventory."
          : "Configured addresses match the current inventory.",
      missing,
      stale,
    };
  }

  const eks = config.eks;
  if (eks) {
    const aws = <T>(...args: string[]) =>
      jsonCommand<T>(
        "aws",
        [
          ...args,
          "--region",
          eks.region,
          "--output",
          "json",
          "--no-cli-pager",
          "--cli-connect-timeout",
          "5",
          "--cli-read-timeout",
          "15",
        ],
        deadline,
      );
    let verifiedCluster: EksCluster | undefined;
    const identity = await check(
      "eks-cluster-identity",
      "Verify the named EKS cluster and selected kubeconfig endpoint or tunnel TLS server name; never combine inventories from different clusters.",
      async () => {
        const identity = await aws<{ Account?: string } | null>("sts", "get-caller-identity");
        if (!/^\d{12}$/.test(identity?.Account ?? "")) {
          throw new Error("incomplete AWS identity");
        }
        if (identity?.Account !== eks.account) {
          return {
            status: "failed",
            summary: "The authenticated AWS account does not match the intended cluster ARN.",
          };
        }
        const { cluster } = await aws<{ cluster: EksCluster }>(
          "eks",
          "describe-cluster",
          "--name",
          eks.cluster,
        );
        const selected = await kube<KubeConnection[]>(
          "config",
          "view",
          "--minify",
          "--flatten",
          "--raw",
          "-o",
          "jsonpath-as-json={.clusters[*].cluster}",
        );
        const connection = selected[0];
        const expected = new URL(cluster.endpoint);
        if (!connection) {
          throw new Error("incomplete selected connection");
        }
        const endpoint = new URL(connection.server);
        const tunnel =
          ["127.0.0.1", "[::1]"].includes(endpoint.hostname) &&
          endpoint.port !== "" &&
          endpoint.href === endpoint.origin + "/" &&
          connection["tls-server-name"] === expected.hostname;
        const actualHost = connection["tls-server-name"] ?? endpoint.hostname;
        const caData = cluster.certificateAuthority?.data;
        const matches =
          cluster.arn === eks.clusterArn &&
          cluster.name === eks.cluster &&
          typeof caData === "string" &&
          caData.length > 0 &&
          connection["certificate-authority-data"] === caData &&
          expected.protocol === "https:" &&
          expected.href === expected.origin + "/" &&
          (endpoint.href === expected.href || tunnel) &&
          endpoint.protocol === "https:" &&
          !connection["insecure-skip-tls-verify"] &&
          actualHost === expected.hostname;
        if (matches) {
          // Later kubectl calls reload the context. Pin the verified transport on
          // every read so a changed kubeconfig cannot redirect the observations.
          if (directory === undefined) {
            throw new Error("missing temporary directory");
          }
          const ca = join(directory, "eks-ca.pem");
          await writeFile(ca, Buffer.from(caData, "base64"), {
            flag: "wx",
            mode: 0o600,
          });
          transport = [
            `--server=${endpoint.href}`,
            `--tls-server-name=${expected.hostname}`,
            `--certificate-authority=${ca}`,
          ];
          verifiedCluster = cluster;
        }
        return {
          status: matches ? "passed" : "failed",
          summary: matches
            ? "The AWS account, cluster ARN, TLS endpoint and CA identify the intended EKS cluster."
            : "The cluster ARN, Kubernetes TLS endpoint or CA does not identify the intended EKS cluster.",
        };
      },
    );
    if (identity?.status === "passed") {
      await check(
        "webhook-addresses",
        "Refresh the named EKS control-plane interface inventory; reconcile infrastructure-owned webhook ingress /32s without widening them.",
        async () => {
          if (!verifiedCluster) {
            throw new Error("missing verified cluster");
          }
          const { vpcId, clusterSecurityGroupId } = verifiedCluster.resourcesVpcConfig;
          if (!/^vpc-[a-f0-9]+$/.test(vpcId) || !/^sg-[a-f0-9]+$/.test(clusterSecurityGroupId)) {
            throw new Error("incomplete EKS VPC inventory");
          }
          const result = await aws<NetworkInterfaces>(
            "ec2",
            "describe-network-interfaces",
            "--filters",
            `Name=vpc-id,Values=${vpcId}`,
            `Name=group-id,Values=${clusterSecurityGroupId}`,
            `Name=description,Values=Amazon EKS ${eks.cluster}`,
          );
          if (result.NextToken) {
            throw new Error("incomplete EC2 page");
          }
          const addresses = result.NetworkInterfaces.flatMap((item) => {
            if (!item.PrivateIpAddresses.length) {
              throw new Error("empty interface address inventory");
            }
            return item.PrivateIpAddresses.map((address) => address.PrivateIpAddress);
          });
          if (addresses.length === 0 || addresses.some((address) => isIP(address) !== 4)) {
            throw new Error("incomplete webhook inventory");
          }
          return comparison(
            eks.webhookCidrs,
            addresses.map((address) => `${address}/32`),
          );
        },
      );
    } else {
      kubeUnavailable =
        "The selected Kubernetes target could not be bound to the intended EKS cluster.";
      checks.push({
        id: "webhook-addresses",
        status: "unknown",
        summary: "The EKS cluster identity was not verified.",
        action: "Resolve eks-cluster-identity before comparing webhook addresses.",
      });
    }
  }

  let service: ApiService | undefined;
  let verifiedContext = false;
  const api = await check(
    "kubernetes-api",
    "Verify the selected kubeconfig, credentials, TLS trust and private API route; retry this read from the intended operator network.",
    async () => {
      // This local view redacts credential values. Reject a context that would
      // send anonymous requests or skip server verification, even if GET is public.
      const view = await kube<KubeconfigView>("config", "view", "--minify", "-o", "json");
      const cluster = view.clusters?.[0]?.cluster;
      const user = view.users?.[0]?.user;
      if (!cluster) {
        throw new Error("incomplete kubeconfig view");
      }
      if (
        new URL(cluster.server).protocol !== "https:" ||
        cluster["insecure-skip-tls-verify"] ||
        !(
          user?.token ||
          user?.tokenFile ||
          user?.exec?.command ||
          user?.["auth-provider"] ||
          ((user?.["client-certificate"] || user?.["client-certificate-data"]) &&
            (user?.["client-key"] || user?.["client-key-data"])) ||
          (user?.username && user?.password)
        )
      ) {
        kubeUnavailable =
          "The selected context requires verified HTTPS and configured credentials.";
        return { status: "failed", summary: kubeUnavailable };
      }
      verifiedContext = true;
      service = await kube<ApiService>(
        "-n",
        "default",
        "get",
        "service",
        "kubernetes",
        "-o",
        "json",
      );
      if (
        !service?.metadata?.uid ||
        service.metadata.namespace !== "default" ||
        service.metadata.name !== "kubernetes"
      ) {
        throw new Error("incomplete API Service");
      }
      return {
        status: "passed",
        summary: "The selected identity can read the Kubernetes API Service.",
      };
    },
  );

  if (
    !verifiedContext ||
    (api.status === "unknown" && /endpoint|target|deadline/.test(api.summary))
  ) {
    kubeUnavailable = api.summary;
  }

  for (const crd of config.crds) {
    await check(
      `crd:${crd.name}`,
      "Verify that the prerequisite installer established this CRD and serves the required API version.",
      async () => {
        const item = await kube<CustomResourceDefinition | null>(
          "get",
          "customresourcedefinitions.apiextensions.k8s.io",
          crd.name,
          "--ignore-not-found",
          "-o",
          "json",
        );
        if (item === null) {
          return { status: "failed", summary: "The required CRD does not exist." };
        }
        const established =
          !item.metadata?.deletionTimestamp &&
          ["Established", "NamesAccepted"].every((type) =>
            item.status?.conditions?.some(
              (condition) => condition.type === type && condition.status === "True",
            ),
          );
        const served = item.spec?.versions?.some(
          (version) => version.name === crd.version && version.served,
        );
        return {
          status: established && served ? "passed" : "failed",
          summary:
            established && served
              ? "The established CRD serves the required API version."
              : "The required CRD is not established or does not serve the selected version.",
        };
      },
    );
  }

  await check(
    "gateway-class",
    "Inspect the selected GatewayClass owner and its controller; require a current Accepted condition before installing OCE.",
    async () => {
      const item = await kube<GatewayClass | null>(
        "get",
        "gatewayclasses.gateway.networking.k8s.io",
        config.gatewayClass.name,
        "--ignore-not-found",
        "-o",
        "json",
      );
      if (item === null) {
        return { status: "failed", summary: "The selected GatewayClass does not exist." };
      }
      if (!item.metadata?.generation || typeof item.spec?.controllerName !== "string") {
        throw new Error("incomplete GatewayClass");
      }
      const accepted = item.status?.conditions?.find((condition) => condition.type === "Accepted");
      const owner =
        !item.metadata.deletionTimestamp &&
        item.spec.controllerName === config.gatewayClass.controllerName;
      const fresh = accepted?.observedGeneration === item.metadata.generation;
      return {
        status: owner && fresh && accepted.status === "True" ? "passed" : "failed",
        summary:
          owner && fresh && accepted.status === "True"
            ? "The selected controller accepted this GatewayClass generation."
            : "The GatewayClass owner or current Accepted condition does not match.",
        resource: `${config.gatewayClass.name}@${item.metadata.uid}`,
      };
    },
  );

  for (const controller of config.controllers) {
    await check(
      `controller:${controller.namespace}/${controller.name}`,
      "Inspect this Deployment's rollout, Pods and events; restore its intended replicas before installing OCE.",
      async () => {
        const item = parseJson<DeploymentReadiness | null>(
          await projectNamed("deployments.apps", controller, deploymentReadinessProjection),
        );
        if (item === null) {
          return {
            status: "failed",
            summary: "The selected controller Deployment does not exist.",
          };
        }
        const rolloutCounts = [
          item.metadata?.generation,
          item.spec?.replicas,
          item.status?.observedGeneration,
          item.status?.updatedReplicas,
          item.status?.availableReplicas,
          item.status?.replicas,
        ];
        if (
          item.metadata?.deletionTimestamp === null ||
          item.spec === null ||
          item.status === null ||
          rolloutCounts.some((count) => count !== undefined && !Number.isInteger(count)) ||
          item.status?.conditions === null ||
          item.status?.conditions?.some((condition) => !condition?.type || !condition.status)
        ) {
          throw new DiagnosticError("The response lacks valid controller rollout fields.");
        }
        const desired = item.spec?.replicas ?? 1;
        const current =
          !item.metadata?.deletionTimestamp &&
          Number.isInteger(item.metadata?.generation) &&
          item.status?.observedGeneration === item.metadata?.generation;
        const available = item.status?.conditions?.some(
          (condition) => condition?.type === "Available" && condition.status === "True",
        );
        const ready =
          current &&
          available &&
          desired > 0 &&
          item.status?.updatedReplicas === desired &&
          item.status?.availableReplicas === desired &&
          item.status?.replicas === desired;
        return {
          status: ready ? "passed" : "failed",
          summary: ready
            ? "All intended controller replicas are updated and available."
            : "The controller has not completed its current rollout.",
          resource: `${controller.namespace}/${controller.name}@${item.metadata?.uid ?? undefined}`,
        };
      },
    );
  }

  await check(
    "api-addresses",
    "Refresh the selected API Service and EndpointSlice inventory; reconcile the expected /32s and infrastructure-owned policies before installation.",
    async () => {
      if (api?.status !== "passed") {
        throw new DiagnosticError(api.summary);
      }
      const slices = await kube<KubernetesList<EndpointSlice>>(
        "-n",
        "default",
        "get",
        "endpointslices.discovery.k8s.io",
        "-l",
        "kubernetes.io/service-name=kubernetes",
        "-o",
        "json",
      );
      if (slices.metadata?.continue) {
        throw new Error("incomplete EndpointSlice list");
      }
      if (!service) {
        throw new Error("missing observed API Service");
      }
      const serviceIPs = (service.spec.clusterIPs ?? [service.spec.clusterIP]).filter(
        (ip) => isIP(ip) === 4,
      );
      const endpoints = slices.items
        .filter((slice) => slice.addressType === "IPv4")
        .flatMap((slice) => slice.endpoints.flatMap((endpoint) => endpoint.addresses));
      if (!serviceIPs.length || !endpoints.length || endpoints.some((ip) => isIP(ip) !== 4)) {
        throw new Error("incomplete IPv4 API inventory");
      }
      const addresses = [...serviceIPs, ...endpoints];
      return comparison(
        config.apiCidrs,
        addresses.map((address) => `${address}/32`),
      );
    },
  );

  const dependency = config.serviceDependency;
  if (dependency) {
    const { service: selectedService, policy, tls } = dependency;
    await check(
      "service-egress",
      "Reconcile the exact Service /32 and destination Pod grants through the NetworkPolicy owner.",
      async () => {
        const observedService = await getNamed<ApiService>("service", selectedService);
        return serviceEgress(dependency, observedService, () =>
          getNamed<NetworkPolicy>("networkpolicies.networking.k8s.io", policy),
        );
      },
    );
    if (tls) {
      await check(
        "service-tls",
        "Verify the selected Secret and renew its serving certificate for the expected serverName through the certificate owner.",
        () =>
          readCertificate(
            { namespace: selectedService.namespace, name: tls.secretName },
            tls.serverName,
          ),
      );
    }
  }

  const client = config.clientCertificate;
  if (client) {
    await check(
      "client-certificate",
      "Verify the selected container's certificate path and renew its mounted Secret through the certificate owner.",
      async () => {
        const { kind, namespace } = client.workload;
        if (kubeUnavailable) {
          throw new DiagnosticError(kubeUnavailable);
        }
        // An older Go-template printer can dump the input object when it cannot
        // iterate a string length. Check that capability with an empty kubeconfig.
        const templateSupport = await commandOutput(
          "kubectl",
          [
            "--kubeconfig",
            process.platform === "win32" ? "NUL" : "/dev/null",
            "config",
            "view",
            "-o",
            "go-template={{range 1}}supported{{end}}",
          ],
          deadline,
          "discard",
        ).catch(() => "");
        if (templateSupport !== "supported") {
          throw new DiagnosticError(
            "The kubectl client cannot safely project the selected workload. Use the kubectl version listed in the release tools guide.",
          );
        }
        const workload = parseJson<ClientWorkload | null>(
          await projectNamed(
            kind === "Deployment" ? "deployments.apps" : "statefulsets.apps",
            client.workload,
            clientWorkloadProjection(client),
          ),
        );
        if (!workload) {
          return { status: "failed", summary: "The selected client workload does not exist." };
        }
        if (workload.kind !== kind || workload.apiVersion !== "apps/v1") {
          throw new DiagnosticError(
            "The response does not identify the selected client workload kind.",
          );
        }
        const identity = observeResource(kind, client.workload, workload.metadata);
        const resources = [identity];
        if (workload.metadata?.deletionTimestamp) {
          return {
            status: "failed",
            summary: "The selected client workload is terminating.",
            resources,
          };
        }
        try {
          const mount = mountedClientSecret(client, workload);
          if (!mount) {
            return {
              status: "failed",
              summary:
                "The certificate path does not resolve to one mounted tls.crt Secret item in the selected container.",
              resources,
            };
          }
          const certificate = await readCertificate(
            { namespace, name: mount.name },
            undefined,
            mount.requiredKeys,
          );
          return { ...certificate, resources: [...resources, ...(certificate.resources ?? [])] };
        } catch (error) {
          return { ...unreadable(error), resources };
        }
      },
    );
  }

  await check(
    "resource-quotas",
    "Inspect ResourceQuota status and planned chart requests in this namespace; ask its owner to resolve exhausted or unreported quotas.",
    async () => {
      const namespace = await kube<{ metadata?: KubernetesMetadata } | null>(
        "get",
        "namespace",
        config.namespace,
        "--ignore-not-found",
        "-o",
        "json",
      );
      if (namespace === null) {
        return {
          status: "unknown",
          summary: "The target namespace does not exist; its admission quotas cannot be inspected.",
        };
      }
      const list = await kube<KubernetesList<ResourceQuota>>(
        "-n",
        config.namespace,
        "get",
        "resourcequotas",
        "-o",
        "json",
      );
      if (
        !Array.isArray(list.items) ||
        list.metadata?.continue ||
        namespace.metadata?.deletionTimestamp
      ) {
        throw new Error("incomplete quota inventory");
      }
      const limits: QuotaLimit[] = [];
      for (const quota of list.items) {
        for (const [resource, field] of [
          ["count/jobs.batch", "jobs"],
          ["count/replicasets.apps", "replicaSets"],
        ] as const) {
          if (!(resource in quota.spec.hard) && !(resource in (quota.status?.hard ?? {}))) {
            continue;
          }
          const additional = config.peakAdditional?.[field];
          const hardValue = quota.status?.hard?.[resource];
          const usedValue = quota.status?.used?.[resource];
          const limit = { quota: quota.metadata.name, resource, additional };
          const hard = quantity(hardValue);
          const configured = quantity(quota.spec.hard[resource]);
          const used = quantity(usedValue);
          if (
            !hard ||
            !configured ||
            !used ||
            additional === undefined ||
            hard.numerator * configured.denominator !== configured.numerator * hard.denominator ||
            quota.spec.scopes?.length ||
            quota.spec.scopeSelector?.matchExpressions?.length
          ) {
            limits.push({ ...limit, status: "unknown" });
            continue;
          }
          const needed = used.numerator + BigInt(additional) * used.denominator;
          limits.push({
            ...limit,
            status:
              needed * hard.denominator > hard.numerator * used.denominator ? "failed" : "passed",
            used: used.text,
            hard: hard.text,
          });
        }
      }
      if (limits.some((limit) => limit.status === "failed")) {
        return {
          status: "failed",
          summary: "At least one object quota cannot fit the planned peak.",
          limits,
        };
      }
      if (limits.some((limit) => limit.status === "unknown")) {
        return {
          status: "unknown",
          summary: "An object quota lacks a comparable limit, usage, scope or planned peak.",
          limits,
        };
      }
      return {
        status: "passed",
        summary: limits.length
          ? "Observed object quotas can fit the planned peak."
          : "No Job or ReplicaSet object quota is configured in this namespace.",
        limits,
      };
    },
  );

  return {
    ...(config.eks ? { expectedClusterArn: config.eks.clusterArn } : {}),
    context: config.context,
    namespace: config.namespace,
    checkedAt: new Date().toISOString(),
    checks,
    limits: [
      "Observations are not atomic and may change immediately.",
      "Address inventory does not verify NetworkPolicy enforcement, webhook admission or Pod connectivity.",
      ...(config.serviceDependency
        ? [
            "Verify the selected NetworkPolicy source Pod selector covers the calling workload.",
            "Verify policy enforcement, the served TLS leaf and its trust chain separately from the caller's network.",
          ]
        : []),
      ...(config.clientCertificate
        ? [
            "The client certificate check observes the workload template and Secret only. It does not observe mounted or active process credentials, gateway client-CA acceptance, peer identity or an mTLS RPC.",
          ]
        : []),
      "Quota observations do not predict chart admission, node capacity or storage availability.",
    ],
  };
}

try {
  const { values } = parseArgs({
    options: { config: { type: "string" }, json: { type: "boolean", default: false } },
  });
  if (!values.config) {
    throw new DiagnosticError(
      "Usage: node scripts/diagnose-kubernetes-prerequisites.ts --config FILE [--json]",
    );
  }
  const config = validateConfig(JSON.parse(await readFile(values.config, "utf8")));
  const directory = config.eks ? await mkdtemp(join(tmpdir(), "oce-prerequisites-")) : undefined;
  let report: DiagnosticReport;
  try {
    report = await diagnose(config, directory);
  } finally {
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `Context ${JSON.stringify(report.context)}, namespace ${report.namespace}\n`,
    );
    if (report.expectedClusterArn) {
      process.stdout.write(`Expected EKS cluster ${report.expectedClusterArn}\n`);
    }
    for (const check of report.checks) {
      process.stdout.write(`${check.status.toUpperCase()} ${check.id}: ${check.summary}\n`);
      if (check.action) {
        process.stdout.write(`  Next: ${check.action}\n`);
      }
      for (const field of ["missing", "stale", "limits", "resources"] as const) {
        if (check[field]?.length) {
          process.stdout.write(`  ${field}: ${JSON.stringify(check[field])}\n`);
        }
      }
    }
    process.stdout.write(`${report.limits.join("\n")}\n`);
  }
  if (report.checks.some((check) => check.status === "failed")) {
    process.exitCode = 1;
  } else if (report.checks.some((check) => check.status === "unknown")) {
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(
    `Prerequisite diagnosis could not start: ${error instanceof DiagnosticError ? error.message : "check command options and the readable JSON plan"}\n`,
  );
  process.exitCode = 2;
}

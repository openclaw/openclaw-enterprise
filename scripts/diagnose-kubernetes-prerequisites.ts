#!/usr/bin/env node
import { spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { get, type IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual, parseArgs } from "node:util";

type PeakAdditional = { jobs: number; replicaSets: number };
type DeploymentSelection = { namespace: string; name: string };
type CrdSelection = { name: string; version: string };
type ServiceDependency = {
  service: DeploymentSelection & { port: number };
  policy: DeploymentSelection;
  tls?: { secretName: string; serverName: string };
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
  kind: "Service" | "NetworkPolicy" | "Secret";
  uid: string;
  resourceVersion: string;
};
type Condition = { type: string; status: string; observedGeneration?: number };
type TlsSecret = { metadata?: NamedMetadata; data?: { "tls.crt"?: string } };

type KubeConnection = {
  server: string;
  "tls-server-name"?: string;
  "certificate-authority-data"?: string;
  "insecure-skip-tls-verify"?: boolean;
};

type KubeconfigView = {
  "current-context"?: string;
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

type Deployment = {
  metadata?: KubernetesMetadata;
  spec?: { replicas?: number };
  status?: {
    conditions?: Condition[];
    observedGeneration?: number;
    updatedReplicas?: number;
    availableReplicas?: number;
    replicas?: number;
  };
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
  action?: string;
  resource?: string;
  missing?: string[];
  stale?: string[];
  limits?: QuotaLimit[];
  resources?: ResourceObservation[];
};

type CheckReport = CheckResult & { id: string };
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
    peakAdditional,
    eks,
  };
}

const kubectlEnv = {
  ...process.env,
  KUBECTL_KUBERC: "false",
  KUBERC: "off",
  AWS_PAGER: "",
  AWS_CLI_AUTO_PROMPT: "off",
};
const outputLimit = 2 * 1024 * 1024;

// A credential plugin can inherit its parent's pipes. Bound both the wait and the
// captured bytes even when the CLI or a descendant never closes those pipes.
async function commandOutput(
  command: string,
  args: string[],
  deadline: number,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const timeout = Math.min(20_000, deadline - performance.now());
  if (timeout <= 0) {
    throw new DiagnosticError("The collection deadline expired.");
  }
  const grouped = process.platform !== "win32";
  const child = spawn(command, args, {
    detached: grouped,
    stdio: ["ignore", "pipe", "pipe"],
    env: kubectlEnv,
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
      child.stdout.destroy();
      child.stderr.destroy();
      cleanup();
      reject(new DiagnosticError(reason));
    }
    const timer = setTimeout(() => stop("The selected command exceeded its deadline."), timeout);
    const abort = () => stop("The collection was interrupted.");
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    signal.addEventListener("abort", abort, { once: true });
    for (const [stream, output] of [
      [child.stdout, stdout],
      [child.stderr, stderr],
    ] as const) {
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > outputLimit) {
          stop("The read exceeded the output limit.");
        } else {
          output.push(chunk);
        }
      });
    }
    child.once("error", (error: NodeJS.ErrnoException) => {
      cleanup();
      reject(
        new DiagnosticError(
          error.code === "ENOENT"
            ? "A required command is not installed."
            : "The command could not start.",
        ),
      );
    });
    child.once("close", (code) => {
      cleanup();
      resolve(code);
    });
  });
  if (result !== 0) {
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

// A proxy uses a single upstream round trip. Neither it nor node:http follows a
// redirect. Use a new, path-filtered socket per read to preserve token-file and
// exec credential reloading. The supervisor closes the group on parent death
// (stdin EOF) or deadline, including when a credential plugin is still running.
const proxySupervisor = `
  import { spawn } from "node:child_process";
  const [timeout, socketFd, ...args] = process.argv.slice(1);
  const proxy = spawn("kubectl", args, {
    stdio: ["ignore", "ignore", "ignore", ...(socketFd === "3" ? [3] : [])],
  });
  const stop = () => process.kill(-process.pid, "SIGKILL");
  proxy.once("error", stop);
  proxy.once("exit", stop);
  process.stdin.once("end", stop).resume();
  setTimeout(stop, Number(timeout));
`;

async function kubernetesGet<T>(
  socket: string,
  kubeconfig: string,
  context: string,
  path: string,
  deadline: number,
  signal: AbortSignal,
  optional: boolean,
): Promise<T | null> {
  const timeout = Math.floor(Math.min(15_000, deadline - performance.now()));
  if (timeout <= 0) {
    throw new DiagnosticError("The collection deadline expired.");
  }
  if (process.platform === "win32") {
    throw new DiagnosticError("Kubernetes reads require a private Unix socket.");
  }
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
  requestSignal.throwIfAborted();
  // Unix socket paths are limited in bytes. On Linux pin the same private
  // directory by descriptor and use the short procfs spelling on both ends.
  const useDirectoryFd = Buffer.byteLength(socket) > 103;
  if (useDirectoryFd && process.platform !== "linux") {
    throw new DiagnosticError(
      "The selected endpoint requires a shorter private TMPDIR for its Unix socket.",
    );
  }
  await using socketDirectory = useDirectoryFd
    ? await open(dirname(socket), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    : undefined;
  const socketName = basename(socket);
  const localSocket = socketDirectory
    ? `/proc/self/fd/${socketDirectory.fd}/${socketName}`
    : socket;
  const proxySocket = socketDirectory ? `/proc/self/fd/3/${socketName}` : socket;
  requestSignal.throwIfAborted();
  const exactPath = path.replace(/\?.*$/u, "").replaceAll(".", "\\.");
  const proxy = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      proxySupervisor,
      String(timeout),
      socketDirectory ? "3" : "",
      "--kubeconfig",
      kubeconfig,
      "--context",
      context,
      "proxy",
      "--append-server-path",
      "--unix-socket",
      proxySocket,
      `--accept-paths=^${exactPath}$`,
      // kubectl filters methods by rejection. Only the three letters of GET can pass.
      "--reject-methods=^(.?.?|.{4}.*|[^G]..|G[^E].|GE[^T])$",
    ],
    {
      detached: true,
      stdio: ["pipe", "ignore", "ignore", ...(socketDirectory ? [socketDirectory.fd] : [])],
      env: kubectlEnv,
    },
  );
  proxy.stdin?.on("error", () => {});
  let closed = false;
  const settled = new Promise<void>((resolve) => {
    proxy.once("error", () => {});
    proxy.once("close", () => {
      closed = true;
      resolve();
    });
  });
  try {
    while (!(await stat(localSocket).catch(() => undefined))?.isSocket()) {
      if (closed) {
        throw new DiagnosticError(
          "The private transport to the selected endpoint could not start.",
        );
      }
      await delay(20, undefined, { signal: requestSignal });
    }

    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      get(
        {
          socketPath: localSocket,
          agent: false,
          path,
          headers: { host: "localhost", accept: "application/json" },
          signal: requestSignal,
        },
        resolve,
      ).once("error", reject);
    });
    const code = response.statusCode ?? 0;
    if (code !== 200) {
      response.destroy();
      if (code === 404 && optional) {
        return null;
      }
      if (code >= 300 && code < 400) {
        throw new DiagnosticError("The selected endpoint returned an unexpected redirect.");
      }
      if (code === 401 || code === 403) {
        throw new DiagnosticError(
          code === 401
            ? "The selected credentials could not authenticate."
            : "The selected identity is not authorized to read this resource.",
        );
      }
      throw new DiagnosticError(
        "The selected endpoint did not return a usable Kubernetes response.",
      );
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      if (!Buffer.isBuffer(chunk)) {
        throw new DiagnosticError("The Kubernetes response could not be read.");
      }
      size += chunk.length;
      if (size > outputLimit) {
        throw new DiagnosticError("The read exceeded the output limit.");
      }
      chunks.push(chunk);
    }
    const resource = parseJson<unknown>(Buffer.concat(chunks).toString());
    if (
      !isObject(resource) ||
      typeof resource.apiVersion !== "string" ||
      !resource.apiVersion ||
      typeof resource.kind !== "string" ||
      !resource.kind ||
      !isObject(resource.metadata)
    ) {
      throw new DiagnosticError("The Kubernetes response did not contain a resource JSON object.");
    }
    return resource as T;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof DiagnosticError) {
      throw error;
    }
    if (requestSignal.aborted) {
      throw new DiagnosticError("The selected endpoint did not respond before the deadline.");
    }
    throw new DiagnosticError("The read failed or returned incomplete data.");
  } finally {
    proxy.stdin?.end();
    await settled;
    // The enclosing run removes the directory even if this early unlink fails.
    await rm(localSocket, { force: true }).catch(() => {});
  }
}

function parseJson<T>(output: string): T {
  // Callers project only the fields they inspect. Keep incomplete or malformed
  // observations subject to each check's existing tests and error handling.
  const parsed: unknown = output ? JSON.parse(output) : null;
  return parsed as T;
}

async function readSelectedKubeconfig(
  config: DiagnosticPlan,
  deadline: number,
  signal: AbortSignal,
): Promise<KubeconfigView> {
  const view = parseJson<KubeconfigView>(
    await commandOutput(
      "kubectl",
      [
        "--kubeconfig",
        config.kubeconfig,
        "--context",
        config.context,
        "config",
        "view",
        "--raw",
        "--flatten",
        "--minify",
        "-o",
        "json",
      ],
      deadline,
      signal,
    ),
  );
  if (view?.["current-context"] !== config.context || !view.clusters?.[0]?.cluster) {
    throw new DiagnosticError("The selected kubeconfig context could not be resolved.");
  }

  // Flatten embeds CA and client certificate/key data. Explicit-file config view
  // leaves tokenFile and path-based exec commands relative to the original file.
  const user = view.users?.[0]?.user;
  const sourceDirectory = dirname(resolve(config.kubeconfig));
  if (user?.tokenFile && !isAbsolute(user.tokenFile)) {
    user.tokenFile = resolve(sourceDirectory, user.tokenFile);
  }
  if (user?.exec?.command?.includes(sep) && !isAbsolute(user.exec.command)) {
    user.exec.command = resolve(sourceDirectory, user.exec.command);
  }
  return view;
}

function verifiedHttpsEndpoint(server: string) {
  // Require the authority in the input that kubectl will parse. WHATWG URL
  // parsing alone accepts forms such as "https:1234", which kubectl can use
  // as a plaintext host and port.
  const [, authority, suffix = ""] = /^https:\/\/([^/?#]+)(.*)$/iu.exec(server) ?? [];
  if (!authority || /[@%]/u.test(authority) || /[?#\\\s\p{Cc}]/u.test(server)) {
    return undefined;
  }
  const url = URL.parse(server);
  return url?.hostname ? { url, authority, suffix } : undefined;
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
  const serviceAction = "Verify the selected Service and its configuration with the Service owner.";
  const policyAction = "Verify the selected NetworkPolicy with the policy owner.";
  if (service === null) {
    return {
      status: "failed",
      summary: "The selected Service does not exist.",
      action: serviceAction,
    };
  }
  const resources = [observeResource("Service", selection.service, service.metadata)];
  if (service.metadata?.deletionTimestamp) {
    return {
      status: "failed",
      summary: "The selected Service is terminating.",
      action: serviceAction,
      resources,
    };
  }
  const spec = service.spec;
  if (
    !isObject(spec) ||
    (spec.type !== undefined &&
      spec.type !== "ClusterIP" &&
      spec.type !== "NodePort" &&
      spec.type !== "LoadBalancer" &&
      spec.type !== "ExternalName")
  ) {
    throw new DiagnosticError("The response lacks a complete Service spec.");
  }
  if (spec.type === "ExternalName") {
    return {
      status: "failed",
      summary: "The selected Service is an ExternalName alias and has no ClusterIP.",
      action: serviceAction,
      resources,
    };
  }
  if (!Array.isArray(spec.ports)) {
    throw new DiagnosticError("The response lacks a complete Service spec.");
  }
  const addresses = spec.clusterIPs ?? [spec.clusterIP];
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
      action: serviceAction,
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
      action: policyAction,
      resources,
    };
  }
  resources.push(observeResource("NetworkPolicy", selection.policy, policy.metadata));
  if (policy.metadata?.deletionTimestamp) {
    return {
      status: "failed",
      summary: "The selected NetworkPolicy is terminating.",
      action: policyAction,
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
    ...(missing.length
      ? {
          action:
            "Reconcile the exact Service /32 and destination Pod grants through the NetworkPolicy owner.",
        }
      : {}),
    missing,
    resources,
  };
}

function servingCertificate(
  namespace: string,
  { secretName, serverName }: NonNullable<ServiceDependency["tls"]>,
  secret: TlsSecret | null,
): CheckResult {
  const secretAction = "Verify the selected TLS Secret with the certificate owner.";
  if (secret === null) {
    return {
      status: "failed",
      summary: "The selected TLS Secret does not exist.",
      action: secretAction,
    };
  }
  const resources = [observeResource("Secret", { namespace, name: secretName }, secret.metadata)];
  const failure = (summary: string, action: string): CheckResult => ({
    status: "failed",
    summary,
    action,
    resources,
  });
  if (secret.metadata?.deletionTimestamp) {
    return failure("The selected TLS Secret is terminating.", secretAction);
  }
  const certificate = secret.data?.["tls.crt"] ?? "";
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
    return failure(
      "The selected TLS Secret lacks a readable X.509 leaf in tls.crt.",
      "Ask the certificate owner to verify that tls.crt contains the public serving certificate.",
    );
  }
  const now = Date.now();
  const notBefore = leaf.validFromDate.getTime();
  const notAfter = leaf.validToDate.getTime();
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) {
    return failure("The selected TLS leaf has an unreadable validity window.", secretAction);
  }
  if (now < notBefore) {
    return failure(
      "The selected TLS leaf is not yet valid.",
      "Check the collection clock and ask the certificate owner to verify the leaf's validity window.",
    );
  }
  if (now > notAfter) {
    return failure(
      "The selected TLS leaf has expired.",
      "Ask the certificate owner to renew the expired leaf.",
    );
  }
  if (!leaf.checkHost(serverName, { subject: "never", partialWildcards: false })) {
    return failure(
      "The selected TLS leaf lacks a DNS SAN matching the expected serverName.",
      "Confirm the expected serverName and ask the certificate owner to correct the DNS SAN if needed.",
    );
  }
  return {
    status: "passed",
    summary: "The selected TLS leaf is within its validity window and has a matching DNS SAN.",
    resources,
  };
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
  directory: string,
  signal: AbortSignal,
): Promise<DiagnosticReport> {
  const deadline = performance.now() + 120_000;
  const kubeconfig = join(directory, "kubeconfig.json");
  const checks: CheckReport[] = [];
  let localFailure: CheckResult | undefined;
  let connection: KubeConnection | undefined;
  let selectedEndpoint: ReturnType<typeof verifiedHttpsEndpoint>;
  let blocker: { id: "eks-cluster-identity" | "kubernetes-api"; summary: string } | undefined;
  try {
    const view = await readSelectedKubeconfig(config, deadline, signal);
    connection = view.clusters?.[0]?.cluster;
    selectedEndpoint = connection && verifiedHttpsEndpoint(connection.server);
    const user = view.users?.[0]?.user;
    if (user?.["auth-provider"] !== undefined) {
      // Built-in providers can rotate credentials and persist the successor
      // into the selected file. The temporary copy cannot own that refresh.
      localFailure = {
        status: "failed",
        summary: "The selected context uses an unsupported built-in kubeconfig auth-provider.",
        action:
          "Ask the credential owner for a context using an exec plugin, token or client certificate.",
      };
    } else if (
      user?.exec?.command &&
      process.env.KUBERC !== "off" &&
      process.env.KUBECTL_KUBERC !== "false"
    ) {
      // Suppressing kuberc must not bypass a credential-plugin policy that
      // already applies or appears after the selected context is resolved.
      localFailure = {
        status: "failed",
        summary: "The selected exec plugin requires explicitly disabled kubectl preferences.",
        action:
          "Follow the credential owner's procedure. Set KUBERC=off only if that procedure permits using the plugin without kubectl preferences.",
      };
    } else if (
      !selectedEndpoint ||
      connection?.["insecure-skip-tls-verify"] ||
      !(
        user?.token ||
        user?.tokenFile ||
        user?.exec?.command ||
        ((user?.["client-certificate"] || user?.["client-certificate-data"]) &&
          (user?.["client-key"] || user?.["client-key-data"])) ||
        (user?.username && user?.password)
      )
    ) {
      localFailure = {
        status: "failed",
        summary:
          "The selected context requires a verified https:// endpoint and configured credentials.",
      };
    } else {
      signal.throwIfAborted();
      await writeFile(kubeconfig, JSON.stringify(view), { flag: "wx", mode: 0o600 });
    }
  } catch (error) {
    signal.throwIfAborted();
    localFailure = {
      status: "unknown",
      summary:
        error instanceof DiagnosticError
          ? error.message
          : "The selected kubeconfig could not be resolved into a private copy.",
    };
  }
  let readNumber = 0;
  const kube = <T>(path: string, optional = false) => {
    if (blocker) {
      throw new DiagnosticError(blocker.summary);
    }
    return kubernetesGet<T>(
      join(directory, String(++readNumber)),
      kubeconfig,
      config.context,
      path,
      deadline,
      signal,
      optional,
    );
  };
  const apiV1 = "/api/v1";
  const namespaced = (api: string, namespace: string) => `${api}/namespaces/${namespace}`;
  const getNamed = <T>(api: string, plural: string, { namespace, name }: DeploymentSelection) =>
    kube<T>(`${namespaced(api, namespace)}/${plural}/${name}`, true);
  async function check(
    id: string,
    action: string,
    inspect: () => Promise<CheckResult>,
  ): Promise<CheckResult> {
    signal.throwIfAborted();
    let result: CheckResult;
    try {
      result = await inspect();
    } catch (error) {
      signal.throwIfAborted();
      // Provider errors can contain credential-plugin output or private endpoints.
      result = {
        status: "unknown",
        summary:
          error instanceof DiagnosticError
            ? error.message
            : "The read failed or returned incomplete data.",
      };
    }
    checks.push({
      id,
      ...result,
      ...(result.status === "passed"
        ? {}
        : {
            action:
              result.action ??
              (blocker ? `Resolve ${blocker.id} before retrying this check.` : action),
          }),
    });
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
    const aws = async <T>(...args: string[]) =>
      parseJson<T>(
        await commandOutput(
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
          signal,
        ),
      );
    let verifiedCluster: EksCluster | undefined;
    const identity = await check(
      "eks-cluster-identity",
      "Verify the named EKS cluster and selected kubeconfig endpoint or tunnel TLS server name; never combine inventories from different clusters.",
      async () => {
        if (localFailure) {
          return {
            status: "unknown",
            summary: "The selected kubeconfig did not pass local validation.",
            action: "Resolve kubernetes-api before verifying EKS identity.",
          };
        }
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
        const expected = verifiedHttpsEndpoint(cluster.endpoint);
        if (!connection || !selectedEndpoint || !expected) {
          throw new Error("incomplete selected connection");
        }
        const { url: endpoint, authority, suffix } = selectedEndpoint;
        const port = /^(?:127\.0\.0\.1|\[::1\]):([0-9]+)$/u.exec(authority)?.[1];
        const tunnel =
          isPort(Number(port)) && connection["tls-server-name"] === expected.url.hostname;
        const loopback = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]";
        const actualHost = connection["tls-server-name"] ?? endpoint.hostname;
        const caData = cluster.certificateAuthority?.data;
        const matches =
          cluster.arn === eks.clusterArn &&
          cluster.name === eks.cluster &&
          typeof caData === "string" &&
          caData.length > 0 &&
          connection["certificate-authority-data"] === caData &&
          (expected.suffix === "" || expected.suffix === "/") &&
          (suffix === "" || suffix === "/") &&
          (loopback ? tunnel : endpoint.href === expected.url.href) &&
          actualHost === expected.url.hostname;
        if (matches) {
          // Each API read uses the same private config verified here.
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
      if (!localFailure) {
        blocker = {
          id: "eks-cluster-identity",
          summary: "The selected Kubernetes target could not be bound to the intended EKS cluster.",
        };
      }
      checks.push({
        id: "webhook-addresses",
        status: "unknown",
        summary: "The EKS cluster identity was not verified.",
        action: localFailure
          ? "Resolve kubernetes-api before verifying EKS identity and comparing webhook addresses."
          : "Resolve eks-cluster-identity before comparing webhook addresses.",
      });
    }
  }

  let service: ApiService | null | undefined;
  const api = await check(
    "kubernetes-api",
    "Verify the selected kubeconfig, credentials, TLS trust and private API route; retry this read from the intended operator network.",
    async () => {
      if (localFailure) {
        return localFailure;
      }
      service = await kube<ApiService>(`${namespaced(apiV1, "default")}/services/kubernetes`);
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
    !blocker &&
    (localFailure || (api.status === "unknown" && /endpoint|target|deadline/.test(api.summary)))
  ) {
    blocker = { id: "kubernetes-api", summary: api.summary };
  }

  for (const crd of config.crds) {
    await check(
      `crd:${crd.name}`,
      "Verify that the prerequisite installer established this CRD and serves the required API version.",
      async () => {
        const item = await kube<CustomResourceDefinition>(
          `/apis/apiextensions.k8s.io/v1/customresourcedefinitions/${crd.name}`,
          true,
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
      const item = await kube<GatewayClass>(
        `/apis/gateway.networking.k8s.io/v1/gatewayclasses/${config.gatewayClass.name}`,
        true,
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
        const item = await getNamed<Deployment>("/apis/apps/v1", "deployments", controller);
        if (item === null) {
          return {
            status: "failed",
            summary: "The selected controller Deployment does not exist.",
          };
        }
        const desired = item.spec?.replicas ?? 1;
        const current =
          !item.metadata?.deletionTimestamp &&
          Number.isInteger(item.metadata?.generation) &&
          item.status?.observedGeneration === item.metadata?.generation;
        const available = item.status?.conditions?.some(
          (condition) => condition.type === "Available" && condition.status === "True",
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
          resource: `${controller.namespace}/${controller.name}@${item.metadata?.uid}`,
        };
      },
    );
  }

  await check(
    "api-addresses",
    api.status === "passed"
      ? "Refresh the selected API Service and EndpointSlice inventory; reconcile the expected /32s and infrastructure-owned policies before installation."
      : "Resolve kubernetes-api before comparing API addresses.",
    async () => {
      if (api?.status !== "passed") {
        throw new DiagnosticError(api.summary);
      }
      const slices = await kube<KubernetesList<EndpointSlice>>(
        "/apis/discovery.k8s.io/v1/namespaces/default/endpointslices?labelSelector=kubernetes.io%2Fservice-name%3Dkubernetes",
      );
      if (!slices || slices.metadata?.continue) {
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
      "Verify read access to the selected Service and NetworkPolicy, then retry the checks.",
      async () => {
        const observedService = await getNamed<ApiService>(apiV1, "services", selectedService);
        return serviceEgress(dependency, observedService, () =>
          getNamed<NetworkPolicy>("/apis/networking.k8s.io/v1", "networkpolicies", policy),
        );
      },
    );
    if (tls) {
      await check(
        "service-tls",
        "Verify named Secret read access or ask the certificate owner to run this check.",
        async () =>
          servingCertificate(
            selectedService.namespace,
            tls,
            await getNamed<TlsSecret>(apiV1, "secrets", {
              namespace: selectedService.namespace,
              name: tls.secretName,
            }),
          ),
      );
    }
  }

  await check(
    "resource-quotas",
    "Inspect ResourceQuota status and planned chart requests in this namespace; ask its owner to resolve exhausted or unreported quotas.",
    async () => {
      const namespacePath = namespaced(apiV1, config.namespace);
      const namespace = await kube<{ metadata?: KubernetesMetadata }>(namespacePath, true);
      if (namespace === null) {
        return {
          status: "unknown",
          summary: "The target namespace does not exist; its admission quotas cannot be inspected.",
        };
      }
      const list = await kube<KubernetesList<ResourceQuota>>(`${namespacePath}/resourcequotas`);
      if (
        !list ||
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
      "Quota observations do not predict chart admission, node capacity or storage availability.",
    ],
  };
}

const cancellation = new AbortController();
let signalExitCode: number | undefined;
const stopCollection = (exitCode: number) => () => {
  signalExitCode ??= exitCode;
  cancellation.abort();
};
const hangup = stopCollection(129);
const interrupt = stopCollection(130);
const terminate = stopCollection(143);
process.on("SIGHUP", hangup);
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
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
  const directory = await mkdtemp(join(tmpdir(), "oce-prerequisites-"));
  let report: DiagnosticReport;
  let cleanupFailed = false;
  try {
    report = await diagnose(config, directory, cancellation.signal);
  } finally {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      process.stderr.write(
        `Could not remove the credential-bearing temporary directory ${JSON.stringify(directory)}. Remove only this directory when the process has stopped.\n`,
      );
      cleanupFailed = true;
    }
  }
  if (cleanupFailed) {
    throw new DiagnosticError("The private kubeconfig cleanup failed.");
  }
  cancellation.signal.throwIfAborted();
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
  if (signalExitCode !== undefined) {
    process.exitCode = signalExitCode;
  } else {
    process.stderr.write(
      `Prerequisite diagnosis could not start: ${error instanceof DiagnosticError ? error.message : "check command options and the readable JSON plan"}\n`,
    );
    process.exitCode = 2;
  }
} finally {
  process.off("SIGHUP", hangup);
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
}

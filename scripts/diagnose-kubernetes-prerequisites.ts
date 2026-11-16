#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

type PeakAdditional = { jobs: number; replicaSets: number };
type DeploymentSelection = { namespace: string; name: string };
type CrdSelection = { name: string; version: string };

type PlanInput = {
  kubeconfig?: unknown;
  context?: unknown;
  namespace?: unknown;
  gatewayClass?: { name?: unknown; controllerName?: unknown };
  controllers?: { namespace?: unknown; name?: unknown }[];
  crds?: { name?: unknown; version?: unknown }[];
  apiCidrs?: unknown;
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
  metadata?: { uid?: string; namespace?: string; name?: string };
  spec: { clusterIP: string; clusterIPs?: string[] };
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
  resource?: string;
  missing?: string[];
  stale?: string[];
  limits?: QuotaLimit[];
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

function validateConfig(value: unknown): DiagnosticPlan {
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
    peakAdditional,
    eks,
  };
}

// A credential plugin can inherit its parent's pipes. Bound both the wait and the
// captured bytes even when the CLI or a descendant never closes those pipes.
async function jsonCommand<T>(command: string, args: string[], deadline: number): Promise<T> {
  const timeout = Math.min(20_000, deadline - performance.now());
  if (timeout <= 0) {
    throw new DiagnosticError("The collection deadline expired.");
  }
  const grouped = process.platform !== "win32";
  const child = spawn(command, args, {
    detached: grouped,
    stdio: ["ignore", "pipe", "pipe"],
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
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new DiagnosticError(reason));
    }
    const timer = setTimeout(() => stop("The selected command exceeded its deadline."), timeout);
    for (const [stream, output] of [
      [child.stdout, stdout],
      [child.stderr, stderr],
    ] as const) {
      stream.on("data", (chunk: Buffer) => {
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
  const output = Buffer.concat(stdout).toString().trim();
  // Callers project only the fields they inspect. Keep incomplete or malformed
  // observations subject to each check's existing tests and error handling.
  const parsed: unknown = output ? JSON.parse(output) : null;
  return parsed as T;
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
  const kube = <T>(...args: string[]) => {
    if (kubeUnavailable) {
      throw new DiagnosticError(kubeUnavailable);
    }
    return jsonCommand<T>(
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
    );
  };
  async function check(
    id: string,
    action: string,
    inspect: () => Promise<CheckResult>,
  ): Promise<CheckResult> {
    let result: CheckResult;
    try {
      result = await inspect();
    } catch (error) {
      // Provider errors can contain credential-plugin output or private endpoints.
      result = {
        status: "unknown",
        summary:
          error instanceof DiagnosticError
            ? error.message
            : "The read failed or returned incomplete data.",
      };
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
        const item = await kube<Deployment | null>(
          "-n",
          controller.namespace,
          "get",
          "deployments.apps",
          controller.name,
          "--ignore-not-found",
          "-o",
          "json",
        );
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
      for (const field of ["missing", "stale", "limits"] as const) {
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

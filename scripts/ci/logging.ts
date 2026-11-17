import { createServer } from "node:net";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { assertInsideDirectory } from "../lib/assert-inside-directory.ts";
import { ensureImage } from "./image-pull.ts";
import { ownedName } from "./resource-names.ts";

type CommandExecutor = (
  command: string,
  args: string[],
  options?: { cwd?: string; maxBuffer?: number; timeoutMs?: number },
) => Promise<{ stdout: string }>;

type Cluster = { name: string; directory: string; kubeconfig: string; context: string };
type Endpoint = { cidr: string; port: number };
type DockerAddress = { bindAddress: string; endpointHost: string | undefined; network?: string };
type BackendResource = Record<string, unknown> & {
  network?: string | undefined;
  namespace?: string | undefined;
};
type PrepareOptions = {
  laneName?: string;
  directory?: string;
  cluster?: unknown;
  env?: NodeJS.ProcessEnv;
  execFile?: CommandExecutor;
  registerResource?(kind: string, resource: BackendResource): Promise<{ id?: string } | undefined>;
  root?: string;
  waitForReady?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function arrayValues(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const defaultCollectorContainerPort = 4318;
const ciOtelBackendResourceKind = "ci-otel-backend";
const collectorServiceAccount = "openclaw-enterprise-collector";
const collectorConfigSecret = "occ-otel-collector-config";
const collectorEnvSecret = "occ-otel-collector-exporter";

function assertImmutableImageReference(image: unknown, name: string): asserts image is string {
  if (typeof image !== "string" || !/^\S+@sha256:[a-f0-9]{64}$/i.test(image)) {
    throw new Error(`${name} must be an immutable image@sha256 reference.`);
  }
}

function assertString(value: unknown, description: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${description} is missing.`);
  }
}

function assertIpv4(value: string, description: string) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    throw new Error(`${description} must be an IPv4 address.`);
  }
  for (const part of value.split(".")) {
    if (Number(part) > 255) {
      throw new Error(`${description} must be an IPv4 address.`);
    }
  }
}

function assertIpv4Cidr(value: unknown, description: string): asserts value is string {
  if (typeof value !== "string" || !/^\d{1,3}(?:\.\d{1,3}){3}\/32$/.test(value)) {
    throw new Error(`${description} must identify exactly one IPv4 host with /32.`);
  }
  assertIpv4(value.slice(0, -3), description);
}

function assertOwnedContainerName(value: unknown): asserts value is string {
  assertString(value, "OTel backend container name");
  if (!/^openclaw-ci-otel-[a-z0-9-]+$/.test(value)) {
    throw new Error(`Refusing to manage unowned OTel backend container: ${value}`);
  }
}

function assertKubernetesName(value: unknown, description: string): asserts value is string {
  assertString(value, description);
  if (!/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(value) || value.length > 63) {
    throw new Error(`${description} must be a Kubernetes DNS label.`);
  }
}

function assertOwnedDirectory(directory: unknown, containerName: string) {
  assertString(directory, "OTel backend directory");
  const resolved = resolve(directory);
  if (!isAbsolute(resolved)) {
    throw new Error("OTel backend directory must be absolute.");
  }
  if (!basename(resolved).startsWith(`${containerName}-`)) {
    throw new Error(`Refusing to clean OTel backend directory outside ownership: ${directory}`);
  }
  return resolved;
}

function assertCluster(cluster: unknown): Cluster | undefined {
  if (!cluster) {
    return undefined;
  }
  if (!isRecord(cluster)) {
    throw new Error("cluster.name is missing.");
  }
  assertKubernetesName(cluster.name, "cluster.name");
  if (!cluster.name.startsWith("openclaw-k8s-")) {
    throw new Error(`Refusing to install logging Collector into unowned cluster: ${cluster.name}`);
  }
  assertString(cluster.directory, "cluster.directory");
  assertString(cluster.kubeconfig, "cluster.kubeconfig");
  assertString(cluster.context, "cluster.context");
  const directory = resolve(cluster.directory);
  if (!isAbsolute(directory)) {
    throw new Error("cluster.directory must resolve to an absolute path.");
  }
  if (!basename(directory).startsWith(`${cluster.name}-`)) {
    throw new Error("cluster.directory must be owned by the selected k3d cluster.");
  }
  if (resolve(cluster.kubeconfig) !== join(directory, "kubeconfig")) {
    throw new Error("cluster.kubeconfig must be inside the selected cluster directory.");
  }
  if (cluster.context !== `k3d-${cluster.name}`) {
    throw new Error("cluster.context must select the owned k3d context.");
  }
  return {
    ...cluster,
    name: cluster.name,
    context: cluster.context,
    directory,
    kubeconfig: resolve(cluster.kubeconfig),
  };
}

async function assertExistingDirectory(path: string, description: string) {
  const info = await stat(path);
  if (!info.isDirectory()) {
    throw new Error(`${description} must be a directory: ${path}`);
  }
}

async function readDefaultCollectorImage(root = repositoryRoot) {
  const compose = await readFile(join(root, "compose.logging.yaml"), "utf8");
  const match = compose.match(/^\s*image:\s*(\S+)\s*$/m);
  if (!match) {
    throw new Error("compose.logging.yaml must define services.collector.image.");
  }
  assertImmutableImageReference(match[1], "compose.logging.yaml collector image");
  return match[1];
}

function backendConfig(logsJsonl = "/out/logs.jsonl") {
  return [
    "receivers:",
    "  otlp:",
    "    protocols:",
    "      http:",
    "        endpoint: 0.0.0.0:4318",
    "exporters:",
    "  file:",
    `    path: ${logsJsonl}`,
    "service:",
    "  telemetry:",
    "    logs:",
    "      level: error",
    "  pipelines:",
    "    logs:",
    "      receivers: [otlp]",
    "      exporters: [file]",
    "",
  ].join("\n");
}

async function writePrivateFile(path: string, data: string, mode = 0o600) {
  await writeFile(path, data, { mode });
  await chmod(path, mode);
}

async function reservePort(bindAddress: string) {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, bindAddress, resolvePromise);
  });
  const address = server.address();
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
  if (!address || typeof address === "string") {
    throw new Error("Failed to reserve an OTel port.");
  }
  return address.port;
}

async function dockerBridgeGateway(execFile: CommandExecutor, docker: string) {
  let missingCommand = false;
  try {
    const result = await execFile(docker, [
      "network",
      "inspect",
      "bridge",
      "--format",
      "{{(index .IPAM.Config 0).Gateway}}",
    ]);
    const gateway = result.stdout.trim();
    if (gateway) {
      assertIpv4(gateway, "Docker bridge gateway");
      return gateway;
    }
  } catch (error) {
    missingCommand = isRecord(error) && error.code === "ENOENT";
  }
  if (missingCommand) {
    throw new Error(`Missing required command on PATH: ${docker}`);
  }
  return "172.17.0.1";
}

async function dockerAddress({
  cluster,
  env,
  execFile,
  docker,
}: {
  cluster: Cluster | undefined;
  env: NodeJS.ProcessEnv;
  execFile: CommandExecutor;
  docker: string;
}): Promise<DockerAddress> {
  if (cluster) {
    return {
      bindAddress: env.OCC_CI_OTEL_BACKEND_BIND_ADDRESS ?? "127.0.0.1",
      endpointHost: env.OCC_CI_OTEL_BACKEND_HOST,
      network: `k3d-${cluster.name}`,
    };
  }
  if (env.OCC_CI_OTEL_BACKEND_HOST || env.OCC_CI_OTEL_BACKEND_BIND_ADDRESS) {
    return {
      bindAddress: env.OCC_CI_OTEL_BACKEND_BIND_ADDRESS ?? "127.0.0.1",
      endpointHost: env.OCC_CI_OTEL_BACKEND_HOST ?? "host.docker.internal",
    };
  }
  if (process.platform === "linux") {
    const gateway = await dockerBridgeGateway(execFile, docker);
    return { bindAddress: gateway, endpointHost: gateway };
  }
  return { bindAddress: "127.0.0.1", endpointHost: "host.docker.internal" };
}

function containerUser() {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    return "0:0";
  }
  return `${process.getuid()}:${process.getgid()}`;
}

async function waitForBackend(endpoint: string) {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resourceLogs: [] }),
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(
    `OTel backend did not accept OTLP/HTTP logs before timeout${
      lastError instanceof Error ? `: ${lastError.message}` : ""
    }`,
  );
}

function dockerRunArgs({
  containerName,
  image,
  configPath,
  outputDirectory,
  bindAddress,
  port,
  network,
}: {
  containerName: string;
  image: string;
  configPath: string;
  outputDirectory: string;
  bindAddress: string;
  port: number;
  network: string | undefined;
}) {
  const args = ["run", "--detach", "--name", containerName];
  if (network) {
    args.push("--network", network);
  }
  args.push(
    "--user",
    containerUser(),
    "--publish",
    `${bindAddress}:${port}:${defaultCollectorContainerPort}`,
    "--volume",
    `${configPath}:/etc/otel/backend.yaml:ro`,
    "--volume",
    `${outputDirectory}:/out`,
    "--label",
    "org.openclaw.enterprise.ci.resource=otel-backend",
    image,
    "--config=/etc/otel/backend.yaml",
  );
  return args;
}

async function dockerContainerIp(
  execFile: CommandExecutor,
  docker: string,
  containerName: string,
  network: string | undefined,
) {
  const result = await execFile(docker, [
    "inspect",
    "--format",
    `{{(index .NetworkSettings.Networks ${JSON.stringify(network)}).IPAddress}}`,
    containerName,
  ]);
  const ip = result.stdout.trim();
  assertIpv4(ip, "OTel backend container IP");
  return ip;
}

function yamlBlock(value: string, indent: number) {
  const prefix = " ".repeat(indent);
  return String(value)
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function kubectlArgs(cluster: Cluster, args: string[]) {
  return ["--kubeconfig", cluster.kubeconfig, "--context", cluster.context, ...args];
}

function assertPort(value: unknown, description: string) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${description} must be a TCP port.`);
  }
  return port;
}

async function kubernetesApiEndpoint(
  cluster: Cluster,
  execFile: CommandExecutor,
  kubectl: string,
  env: NodeJS.ProcessEnv,
): Promise<Endpoint> {
  if (env.OCC_CI_OTEL_KUBERNETES_API_CIDR || env.OCC_CI_OTEL_KUBERNETES_API_PORT) {
    assertIpv4Cidr(env.OCC_CI_OTEL_KUBERNETES_API_CIDR, "OCC_CI_OTEL_KUBERNETES_API_CIDR");
    return {
      cidr: env.OCC_CI_OTEL_KUBERNETES_API_CIDR,
      port: assertPort(env.OCC_CI_OTEL_KUBERNETES_API_PORT, "OCC_CI_OTEL_KUBERNETES_API_PORT"),
    };
  }
  const result = await execFile(
    kubectl,
    kubectlArgs(cluster, [
      "get",
      "endpointslices",
      "--namespace",
      "default",
      "--selector",
      "kubernetes.io/service-name=kubernetes",
      "-o",
      "json",
    ]),
  );
  const slices: unknown = JSON.parse(result.stdout);
  for (const slice of arrayValues(isRecord(slices) ? slices.items : undefined)) {
    if (!isRecord(slice)) {
      continue;
    }
    for (const port of arrayValues(slice.ports)) {
      if (!isRecord(port)) {
        continue;
      }
      if (port.protocol && port.protocol !== "TCP") {
        continue;
      }
      const endpointPort = assertPort(port.port, "Kubernetes API EndpointSlice port");
      for (const endpoint of arrayValues(slice.endpoints)) {
        if (!isRecord(endpoint)) {
          continue;
        }
        if (isRecord(endpoint.conditions) && endpoint.conditions.ready === false) {
          continue;
        }
        const ip = arrayValues(endpoint.addresses).find(
          (address): address is string =>
            typeof address === "string" && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address),
        );
        if (!ip) {
          continue;
        }
        assertIpv4(ip, "Kubernetes API EndpointSlice address");
        return { cidr: `${ip}/32`, port: endpointPort };
      }
    }
  }
  throw new Error("Kubernetes API EndpointSlice must expose a ready IPv4 endpoint.");
}

async function collectorSecretsManifest({
  root,
  namespace,
  endpoint,
}: {
  root: string;
  namespace: string;
  endpoint: string;
}) {
  const [collectorConfig, receiverConfig, exporterConfig] = await Promise.all([
    readFile(join(root, "deploy/logging/collector.yaml"), "utf8"),
    readFile(join(root, "deploy/logging/kubernetes.yaml"), "utf8"),
    readFile(join(root, "deploy/logging/exporter.yaml"), "utf8"),
  ]);
  return [
    "apiVersion: v1",
    "kind: Namespace",
    "metadata:",
    `  name: ${namespace}`,
    "  labels:",
    "    app.kubernetes.io/name: openclaw-enterprise",
    `    app.kubernetes.io/instance: ${namespace}`,
    "    app.kubernetes.io/component: collector",
    "    app.kubernetes.io/managed-by: openclaw-enterprise-ci",
    "---",
    "apiVersion: v1",
    "kind: Secret",
    "metadata:",
    `  name: ${collectorConfigSecret}`,
    `  namespace: ${namespace}`,
    "type: Opaque",
    "stringData:",
    "  collector.yaml: |-",
    yamlBlock(collectorConfig, 4),
    "  kubernetes.yaml: |-",
    yamlBlock(receiverConfig, 4),
    "  exporter.yaml: |-",
    yamlBlock(exporterConfig, 4),
    "---",
    "apiVersion: v1",
    "kind: Secret",
    "metadata:",
    `  name: ${collectorEnvSecret}`,
    `  namespace: ${namespace}`,
    "type: Opaque",
    "stringData:",
    `  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: ${JSON.stringify(endpoint)}`,
    "",
  ].join("\n");
}

async function renderCollectorManifest({
  root,
  namespace,
  image,
  exporterCidr,
  exporterPort,
  kubernetesApi,
  env,
  execFile,
}: {
  root: string;
  namespace: string;
  image: string;
  exporterCidr: string;
  exporterPort: number;
  kubernetesApi: Endpoint;
  env: NodeJS.ProcessEnv;
  execFile: CommandExecutor;
}) {
  const helm = env.OCC_HELM_BIN ?? "helm";
  const chart = join(root, "deploy/helm/openclaw-enterprise");
  const values = join(root, "deploy/examples/production/values.yaml");
  const args = [
    "template",
    namespace,
    chart,
    "--namespace",
    namespace,
    "--values",
    values,
    "--show-only",
    "templates/collector.yaml",
    "--set",
    "logging.collector.enabled=true",
    "--set-string",
    `logging.collector.image=${image}`,
    "--set-string",
    `logging.collector.configSecretName=${collectorConfigSecret}`,
    "--set-string",
    `logging.collector.envSecretName=${collectorEnvSecret}`,
    "--set-string",
    `logging.collector.exporter.cidr=${exporterCidr}`,
    "--set",
    `logging.collector.exporter.port=${exporterPort}`,
    "--set-json",
    `cluster.cidrs=${JSON.stringify([kubernetesApi.cidr])}`,
    "--set",
    `cluster.port=${kubernetesApi.port}`,
  ];
  const result = await execFile(helm, args, { cwd: root, maxBuffer: 2_000_000 });
  return result.stdout;
}

async function installKubernetesCollector({
  root,
  cluster,
  env,
  execFile,
  directory,
  image,
  endpoint,
  endpointHost,
  endpointPort,
  manifestPath,
  secretsManifestPath,
  namespace,
}: {
  root: string;
  cluster: Cluster;
  env: NodeJS.ProcessEnv;
  execFile: CommandExecutor;
  directory: string;
  image: string;
  endpoint: string;
  endpointHost: string;
  endpointPort: number;
  manifestPath: string;
  secretsManifestPath: string;
  namespace: string;
}) {
  const kubectl = env.OCC_KUBECTL_BIN ?? "kubectl";
  const exporterCidr = env.OCC_CI_OTEL_BACKEND_EGRESS_CIDR ?? `${endpointHost}/32`;
  assertIpv4Cidr(exporterCidr, "OCC_CI_OTEL_BACKEND_EGRESS_CIDR");
  const api = await kubernetesApiEndpoint(cluster, execFile, kubectl, env);
  assertInsideDirectory(directory, secretsManifestPath, "OTel Kubernetes Secret manifest");
  assertInsideDirectory(directory, manifestPath, "OTel Kubernetes Collector manifest");
  await writePrivateFile(
    secretsManifestPath,
    await collectorSecretsManifest({ root, namespace, endpoint }),
  );
  await writePrivateFile(
    manifestPath,
    await renderCollectorManifest({
      root,
      namespace,
      image,
      exporterCidr,
      exporterPort: endpointPort,
      kubernetesApi: api,
      env,
      execFile,
    }),
  );
  await execFile(kubectl, kubectlArgs(cluster, ["apply", "-f", secretsManifestPath]));
  await execFile(
    kubectl,
    kubectlArgs(cluster, ["--namespace", namespace, "apply", "-f", manifestPath]),
  );
  await execFile(
    kubectl,
    kubectlArgs(cluster, [
      "--namespace",
      namespace,
      "rollout",
      "status",
      `daemonset/${collectorServiceAccount}`,
      "--timeout=180s",
    ]),
  );
}

async function prepareLogging({
  laneName = "logging",
  directory,
  cluster,
  env = process.env,
  execFile,
  registerResource,
  root = repositoryRoot,
  waitForReady = true,
}: PrepareOptions = {}) {
  if (typeof execFile !== "function") {
    throw new Error("prepareLogging requires execFile.");
  }
  if (typeof registerResource !== "function") {
    throw new Error("prepareLogging requires a registerResource callback.");
  }

  const ownedCluster = assertCluster(cluster);
  const docker = env.OCC_DOCKER_BIN ?? "docker";
  const image = env.OCC_TEST_LOGGING_COLLECTOR_IMAGE ?? (await readDefaultCollectorImage(root));
  assertImmutableImageReference(image, "OCC_TEST_LOGGING_COLLECTOR_IMAGE");

  const containerName = ownedName("openclaw-ci-otel", laneName, { fallbackLabel: "backend" });
  assertOwnedContainerName(containerName);
  const namespace = ownedCluster ? containerName : undefined;
  const baseDirectory = resolve(
    directory ?? ownedCluster?.directory ?? env.RUNNER_TEMP ?? tmpdir(),
  );
  await assertExistingDirectory(baseDirectory, "OTel backend base directory");

  const backendDirectory = join(baseDirectory, `${containerName}-state`);
  assertInsideDirectory(baseDirectory, backendDirectory, "OTel backend directory");
  const outputDirectory = join(backendDirectory, "out");
  const configPath = join(backendDirectory, "backend.yaml");
  const manifestPath = join(backendDirectory, "collector.kubernetes.yaml");
  const secretsManifestPath = join(backendDirectory, "collector.secrets.yaml");
  const logsJsonl = join(outputDirectory, "logs.jsonl");
  const address = await dockerAddress({ cluster: ownedCluster, env, execFile, docker });
  const port = await reservePort(address.bindAddress);
  const localEndpoint = `http://${address.bindAddress}:${port}/v1/logs`;

  const resource = await registerResource(ciOtelBackendResourceKind, {
    containerName,
    directory: backendDirectory,
    outputDirectory,
    configPath,
    logsJsonl,
    image,
    bindAddress: address.bindAddress,
    port,
    network: address.network,
    namespace,
    manifestPath: namespace ? manifestPath : undefined,
    secretsManifestPath: namespace ? secretsManifestPath : undefined,
    cluster: ownedCluster,
  });

  await mkdir(backendDirectory, { recursive: false, mode: 0o700 });
  await chmod(backendDirectory, 0o700);
  await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
  await chmod(outputDirectory, 0o700);
  await writePrivateFile(configPath, backendConfig());

  let endpointHost = address.endpointHost;
  let endpointPort = port;
  try {
    // Pull with retries unless the engine holds the pinned digest (the
    // logging-collector lane pulls it in prepare); `docker run` would pull once,
    // without them.
    await ensureImage(image, { execFile, docker });
    await execFile(
      docker,
      dockerRunArgs({
        containerName,
        image,
        configPath,
        outputDirectory,
        bindAddress: address.bindAddress,
        port,
        network: address.network,
      }),
    );
    if (waitForReady) {
      await waitForBackend(localEndpoint);
    }
    if (ownedCluster && !endpointHost) {
      endpointHost = await dockerContainerIp(execFile, docker, containerName, address.network);
      endpointPort = defaultCollectorContainerPort;
    }
    if (!endpointHost) {
      throw new Error("OTel backend endpoint host could not be resolved.");
    }
    const endpoint = `http://${endpointHost}:${endpointPort}/v1/logs`;
    if (ownedCluster) {
      await installKubernetesCollector({
        root,
        cluster: ownedCluster,
        env,
        execFile,
        directory: backendDirectory,
        image,
        endpoint,
        endpointHost,
        endpointPort,
        manifestPath,
        secretsManifestPath,
        namespace: containerName,
      });
    }

    return {
      env: {
        OCC_TEST_OTEL_LOGS: "1",
        OCC_TEST_OTEL_LOGS_JSONL: logsJsonl,
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: endpoint,
      },
      resource,
      resourceId: resource?.id,
      artifacts: {
        directory: backendDirectory,
        outputDirectory,
        configPath,
        logsJsonl,
        endpoint,
        localEndpoint,
        endpointHost,
        endpointPort,
        containerName,
        namespace,
        manifestPath: namespace ? manifestPath : undefined,
        secretsManifestPath: namespace ? secretsManifestPath : undefined,
      },
    };
  } catch (error) {
    await cleanupLogging(
      {
        kind: ciOtelBackendResourceKind,
        containerName,
        directory: backendDirectory,
        namespace,
        cluster: ownedCluster,
      },
      { env, execFile },
    ).catch(() => {});
    throw error;
  }
}

async function cleanupLogging(
  resource: unknown,
  { env = process.env, execFile }: { env?: NodeJS.ProcessEnv; execFile?: CommandExecutor } = {},
) {
  if (typeof execFile !== "function") {
    throw new Error("cleanupLogging requires execFile.");
  }
  if (!isRecord(resource) || resource.kind !== ciOtelBackendResourceKind) {
    throw new Error(`cleanupLogging requires a ${ciOtelBackendResourceKind} resource.`);
  }
  assertOwnedContainerName(resource.containerName);
  const directory = assertOwnedDirectory(resource.directory, resource.containerName);
  const docker = env.OCC_DOCKER_BIN ?? "docker";
  // k3d logging installs are scoped to the lane-owned cluster. The k3d-cluster
  // cleanup owns all Kubernetes API objects, including Collector Namespace and
  // RBAC, so a dead cluster must not block backend container and JSONL cleanup.
  await execFile(docker, ["rm", "--force", resource.containerName]).catch((error: unknown) => {
    if (
      isRecord(error) &&
      typeof error.message === "string" &&
      /No such container/i.test(error.message)
    ) {
      return;
    }
    throw error;
  });
  await rm(directory, { recursive: true, force: true });
}

export { ciOtelBackendResourceKind, cleanupLogging, prepareLogging, readDefaultCollectorImage };

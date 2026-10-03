import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { pullImage } from "./image-pull.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const defaultCollectorContainerPort = 4318;
const ciOtelBackendResourceKind = "ci-otel-backend";
const collectorServiceAccount = "openclaw-enterprise-collector";
const collectorConfigSecret = "occ-otel-collector-config";
const collectorEnvSecret = "occ-otel-collector-exporter";

function randomSuffix(bytes = 6) {
  return randomUUID()
    .replaceAll("-", "")
    .slice(0, bytes * 2);
}

function slug(value, separator = "-") {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`${separator}+`, "g"), separator)
    .replace(new RegExp(`^${separator}|${separator}$`, "g"), "");
}

function ownedName(prefix, label, { maxLength = 63 } = {}) {
  const suffix = randomSuffix();
  const normalizedPrefix = slug(prefix);
  const normalizedLabel = slug(label) || "backend";
  const fixedLength = normalizedPrefix.length + suffix.length + 2;
  const labelLength = Math.max(1, maxLength - fixedLength);
  return [normalizedPrefix, normalizedLabel.slice(0, labelLength), suffix].join("-");
}

function assertImmutableImageReference(image, name) {
  if (!/^\S+@sha256:[a-f0-9]{64}$/i.test(image ?? "")) {
    throw new Error(`${name} must be an immutable image@sha256 reference.`);
  }
}

function assertString(value, description) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${description} is missing.`);
  }
}

function assertIpv4(value, description) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    throw new Error(`${description} must be an IPv4 address.`);
  }
  for (const part of value.split(".")) {
    if (Number(part) > 255) {
      throw new Error(`${description} must be an IPv4 address.`);
    }
  }
}

function assertIpv4Cidr(value, description) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}\/32$/.test(value ?? "")) {
    throw new Error(`${description} must identify exactly one IPv4 host with /32.`);
  }
  assertIpv4(value.slice(0, -3), description);
}

function assertOwnedContainerName(value) {
  assertString(value, "OTel backend container name");
  if (!/^openclaw-ci-otel-[a-z0-9-]+$/.test(value)) {
    throw new Error(`Refusing to manage unowned OTel backend container: ${value}`);
  }
}

function assertKubernetesName(value, description) {
  assertString(value, description);
  if (!/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(value) || value.length > 63) {
    throw new Error(`${description} must be a Kubernetes DNS label.`);
  }
}

function assertOwnedDirectory(directory, containerName) {
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

function assertCluster(cluster) {
  if (!cluster) {
    return undefined;
  }
  assertKubernetesName(cluster.name, "cluster.name");
  if (!cluster.name.startsWith("openclaw-k8s-")) {
    throw new Error(`Refusing to install logging Collector into unowned cluster: ${cluster.name}`);
  }
  for (const field of ["directory", "kubeconfig", "context"]) {
    assertString(cluster[field], `cluster.${field}`);
  }
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
  return { ...cluster, directory, kubeconfig: resolve(cluster.kubeconfig) };
}

function assertInsideDirectory(parent, child, description) {
  const relativePath = relative(parent, resolve(child));
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`${description} must stay inside ${parent}.`);
  }
}

async function assertExistingDirectory(path, description) {
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

async function writePrivateFile(path, data, mode = 0o600) {
  await writeFile(path, data, { mode });
  await chmod(path, mode);
}

async function reservePort(bindAddress) {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, bindAddress, resolvePromise);
  });
  const address = server.address();
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
  if (!address || typeof address === "string") {
    throw new Error("Failed to reserve an OTel port.");
  }
  return address.port;
}

async function dockerBridgeGateway(execFile, docker) {
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
    if (error.code === "ENOENT") {
      throw new Error(`Missing required command on PATH: ${docker}`);
    }
  }
  return "172.17.0.1";
}

async function dockerAddress({ cluster, env, execFile, docker }) {
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

async function waitForBackend(endpoint) {
  const deadline = Date.now() + 30_000;
  let lastError;
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

async function dockerContainerIp(execFile, docker, containerName, network) {
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

function yamlBlock(value, indent) {
  const prefix = " ".repeat(indent);
  return String(value)
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function kubectlArgs(cluster, args) {
  return ["--kubeconfig", cluster.kubeconfig, "--context", cluster.context, ...args];
}

function assertPort(value, description) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${description} must be a TCP port.`);
  }
  return port;
}

async function kubernetesApiEndpoint(cluster, execFile, kubectl, env) {
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
  const slices = JSON.parse(result.stdout);
  for (const slice of slices.items ?? []) {
    for (const port of slice.ports ?? []) {
      if (port.protocol && port.protocol !== "TCP") {
        continue;
      }
      const endpointPort = assertPort(port.port, "Kubernetes API EndpointSlice port");
      for (const endpoint of slice.endpoints ?? []) {
        if (endpoint.conditions?.ready === false) {
          continue;
        }
        const ip = endpoint.addresses?.find((address) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address));
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

async function collectorSecretsManifest({ root, namespace, endpoint }) {
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
} = {}) {
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

  const containerName = ownedName("openclaw-ci-otel", laneName, { maxLength: 63 });
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
    // Pull with retries; `docker run` would pull it once, without them.
    await pullImage(image, { execFile, docker });
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
        namespace,
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

async function cleanupLogging(resource, { env = process.env, execFile } = {}) {
  if (typeof execFile !== "function") {
    throw new Error("cleanupLogging requires execFile.");
  }
  if (resource?.kind !== ciOtelBackendResourceKind) {
    throw new Error(`cleanupLogging requires a ${ciOtelBackendResourceKind} resource.`);
  }
  assertOwnedContainerName(resource.containerName);
  const directory = assertOwnedDirectory(resource.directory, resource.containerName);
  const docker = env.OCC_DOCKER_BIN ?? "docker";
  // k3d logging installs are scoped to the lane-owned cluster. The k3d-cluster
  // cleanup owns all Kubernetes API objects, including Collector Namespace and
  // RBAC, so a dead cluster must not block backend container and JSONL cleanup.
  await execFile(docker, ["rm", "--force", resource.containerName]).catch((error) => {
    if (/No such container/i.test(error.message)) {
      return;
    }
    throw error;
  });
  await rm(directory, { recursive: true, force: true });
}

export { ciOtelBackendResourceKind, cleanupLogging, prepareLogging, readDefaultCollectorImage };

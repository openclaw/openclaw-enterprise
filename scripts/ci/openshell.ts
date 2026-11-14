import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { assertInsideDirectory } from "../lib/assert-inside-directory.ts";
import { preloadAgentSandboxController } from "./agent-sandbox.ts";
import { selectOpenShellCandidate, verifyOpenShellCandidate } from "./openshell-candidate.ts";
import { downloadPinnedArtifact } from "./routing.ts";

type Environment = Parameters<typeof selectOpenShellCandidate>[0];
type ExecuteFile = Parameters<typeof verifyOpenShellCandidate>[1]["execFile"];
type AgentSandboxNodes = Parameters<typeof preloadAgentSandboxController>[1];
type RegisterControllerImage = Parameters<typeof preloadAgentSandboxController>[2];
type NativeImageSelection = Parameters<RegisterControllerImage>[2];
type RegisterImage = (
  image: string,
  description: string,
  nativeSelection?: NativeImageSelection,
) => Promise<string>;
type DownloadArtifact = (url: string, destination: string, sha256: string) => Promise<void>;

interface Cluster {
  name: string;
  directory: string;
  kubeconfig: string;
  context: string;
}

interface KubectlAsset {
  name: string;
  path: string;
  sha256: string;
}

const openShellVersion = "0.1.8";
const openShellRevision = "f3d976590d3eb1379690a2abaf0f0e26c21d487d";
const agentSandboxVersion = "v0.5.2";
const kubectlVersion = "v1.36.4";
const k3sImage =
  "docker.io/rancher/k3s:v1.36.4-k3s1@sha256:edad48e12bf81c3a09ac1c05c0c0ffaaa22145980b989d6fae84543a76b83657";
const openShellChartArchive = `helm-chart-${openShellVersion}.tgz`;
const openShellWorkspaceChartArchive = `openshell-workspace-${openShellVersion}.tgz`;
const openShellSourceArchive = `openshell-v${openShellVersion}.tar.gz`;
const openShellSourceRoot = `OpenShell-${openShellVersion}`;
const openShellSourceSha256 = "ea6c2dcb50b3ecb3c7bf3d8b5ae4ada71eee838a1a2b12f7a1d2ada76b0837b9";
const agentSandboxManifestSha256 =
  "230ee446d6035f631577e1c6b857f6973a8f09a0a853675d3cc34ebfe47abd6b";
const openShellGatewayImage = `ghcr.io/nvidia/openshell/gateway:${openShellVersion}@sha256:d66352a54c680b652e5ddd7d19b9c1189568d18016f360b9b8c64014f13d89c4`;
const openShellSandboxImage = `ghcr.io/nvidia/openshell/sandbox:${openShellVersion}@sha256:f0fe7dbf18d833acb5da99c405231124718f23b524aa8e3c0108e6f37530033b`;
const openShellSupervisorImage = `ghcr.io/nvidia/openshell/supervisor:${openShellVersion}@sha256:deadeacfdba6d12ca27e538d0002696369d4de5a4fcad075ab503495503af9d1`;
const podSecurityAdmissionConfigName = "openshell-pod-security-admission.yaml";
const podSecurityAdmissionContainerPath = `/etc/openclaw-ci/${podSecurityAdmissionConfigName}`;

const kubectlAssets: Readonly<Record<string, KubectlAsset>> = Object.freeze({
  "darwin:arm64": {
    name: "kubectl-darwin-arm64",
    path: "darwin/arm64/kubectl",
    sha256: "c9e4f713d6fee0043a3d835cca13077cda2bc0973840eb9779360df0b5bdfc69",
  },
  "linux:arm64": {
    name: "kubectl-linux-arm64",
    path: "linux/arm64/kubectl",
    sha256: "0ecf44450ee6063bf19dd166a103ee6df4a9034455c2abce626e6eea657d73fb",
  },
  "linux:x64": {
    name: "kubectl-linux-amd64",
    path: "linux/amd64/kubectl",
    sha256: "8b8f088da2dab964f853b38464033b1be15ede2839eca751482357c45abdd05a",
  },
});

function assertCluster(cluster: Cluster): Cluster {
  for (const field of ["name", "directory", "kubeconfig", "context"] as const) {
    if (typeof cluster?.[field] !== "string" || cluster[field].length === 0) {
      throw new Error(`OpenShell bootstrap requires cluster.${field}.`);
    }
  }
  assertKubernetesName(cluster.name, "cluster.name");
  if (!cluster.name.startsWith("openclaw-k8s-")) {
    throw new Error(`Refusing to prepare OpenShell in unowned cluster: ${cluster.name}`);
  }
  const directory = resolve(cluster.directory);
  if (!isAbsolute(directory)) {
    throw new Error("cluster.directory must resolve to an absolute path.");
  }
  if (!basename(directory).startsWith(`${cluster.name}-`)) {
    throw new Error("cluster.directory must be owned by the selected k3d cluster.");
  }
  const kubeconfig = resolve(cluster.kubeconfig);
  if (kubeconfig !== join(directory, "kubeconfig")) {
    throw new Error("cluster.kubeconfig must be inside the selected cluster directory.");
  }
  if (cluster.context !== `k3d-${cluster.name}`) {
    throw new Error("cluster.context must select the owned k3d context.");
  }
  return { ...cluster, directory, kubeconfig };
}

function assertPrivateDirectory(info: Stats, path: string): void {
  if (!info.isDirectory()) {
    throw new Error(`OpenShell bootstrap path must be a directory: ${path}`);
  }
  if ((info.mode & 0o777) !== 0o700) {
    throw new Error(`OpenShell bootstrap directory must have mode 0700: ${path}`);
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  await assertPrivateDirectory(await stat(path), path);
}

function openShellSourceUrl() {
  return `https://codeload.github.com/NVIDIA/OpenShell/tar.gz/refs/tags/v${openShellVersion}`;
}

function agentSandboxManifestUrl() {
  return `https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${agentSandboxVersion}/sandbox.yaml`;
}

function download(url: string, destination: string, redirects = 0): Promise<void> {
  if (redirects > 5) {
    throw new Error(`Too many redirects while downloading ${url}.`);
  }
  return new Promise((resolve, reject) => {
    const req = request(url, (res) => {
      if (
        res.statusCode !== undefined &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        res.resume();
        download(new URL(res.headers.location, url).toString(), destination, redirects + 1).then(
          resolve,
          reject,
        );
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Download failed for ${url}: HTTP ${res.statusCode}`));
        return;
      }
      const file = createWriteStream(destination, { mode: 0o600 });
      pipeline(res, file).then(resolve, reject);
    });
    req.on("error", reject);
    req.end();
  });
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function verifySha256(path: string, expectedSha256: string): Promise<void> {
  const actual = await sha256File(path);
  if (actual !== expectedSha256) {
    throw new Error(
      `Checksum mismatch for ${basename(path)}: expected ${expectedSha256}, got ${actual}`,
    );
  }
}

async function downloadVerified(
  url: string,
  destination: string,
  expectedSha256: string,
): Promise<void> {
  await rm(destination, { force: true });
  await download(url, destination);
  await chmod(destination, 0o600);
  await verifySha256(destination, expectedSha256);
}

function normalizeArchitecture(arch: string): string {
  switch (arch) {
    case "amd64":
    case "x86_64":
    case "x64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return arch;
  }
}

function selectKubectlAsset(
  platform: string = process.platform,
  arch: string = process.arch,
): KubectlAsset {
  const normalizedPlatform = String(platform).toLowerCase();
  const normalizedArch = normalizeArchitecture(String(arch).toLowerCase());
  const asset = kubectlAssets[`${normalizedPlatform}:${normalizedArch}`];
  if (!asset) {
    throw new Error(
      `OpenShell bootstrap has no pinned kubectl ${kubectlVersion} asset for host ${platform}/${arch}.`,
    );
  }
  return asset;
}

function kubectlReleaseUrl(asset: KubectlAsset): string {
  return `https://dl.k8s.io/release/${kubectlVersion}/bin/${asset.path}`;
}

function assertKubernetesName(value: string, description: string): void {
  if (!/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(value) || value.length > 63) {
    throw new Error(`${description} must be a Kubernetes DNS label.`);
  }
}

function assertRuntimeHandler(value: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("OpenShell runtime handler must be a containerd runtime handler name.");
  }
}

function assertImmutableImageReference(
  image: string | undefined,
  name: string,
): asserts image is string {
  if (!/^\S+@sha256:[a-f0-9]{64}$/i.test(image ?? "")) {
    throw new Error(`${name} must be an immutable image@sha256 reference.`);
  }
}

function chartDeployableImageReference(image: string, name: string): string {
  assertImmutableImageReference(image, name);
  const digestStart = image.search(/@sha256:[a-f0-9]{64}$/i);
  const withoutDigest = image.slice(0, digestStart);
  const digest = image.slice(digestStart);
  const lastSlash = withoutDigest.lastIndexOf("/");
  const tagSeparator = withoutDigest.lastIndexOf(":");
  if (tagSeparator > lastSlash) {
    return image;
  }
  return `${withoutDigest}:local${digest}`;
}

function kubectlArgs(cluster: Cluster, args: string[]): string[] {
  return ["--kubeconfig", cluster.kubeconfig, "--context", cluster.context, ...args];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function acquireOpenShellCharts(execFile: ExecuteFile, helm: string, directory: string) {
  const chartDirectory = join(directory, "chart");
  const chartPath = join(chartDirectory, openShellChartArchive);
  const workspaceChartPath = join(chartDirectory, openShellWorkspaceChartArchive);
  const sourceDirectory = join(directory, "source");
  const sourceArchive = join(sourceDirectory, openShellSourceArchive);
  const sourceRoot = join(sourceDirectory, openShellSourceRoot);
  const sourceChart = join(sourceRoot, "deploy", "helm", "openshell");
  const sourceWorkspaceChart = join(sourceRoot, "deploy", "helm", "openshell-workspace");
  await ensurePrivateDirectory(chartDirectory);
  await ensurePrivateDirectory(sourceDirectory);
  await rm(sourceRoot, { recursive: true, force: true });
  await rm(chartPath, { force: true });
  await rm(workspaceChartPath, { force: true });
  await downloadVerified(openShellSourceUrl(), sourceArchive, openShellSourceSha256);
  await execFile("tar", [
    "-xzf",
    sourceArchive,
    "-C",
    sourceDirectory,
    `${openShellSourceRoot}/deploy/helm/openshell`,
    `${openShellSourceRoot}/deploy/helm/openshell-workspace`,
  ]);
  await execFile(helm, [
    "package",
    sourceChart,
    "--version",
    openShellVersion,
    "--app-version",
    openShellVersion,
    "--destination",
    chartDirectory,
  ]);
  await execFile(helm, [
    "package",
    sourceWorkspaceChart,
    "--version",
    openShellVersion,
    "--app-version",
    openShellVersion,
    "--destination",
    chartDirectory,
  ]);
  await chmod(chartPath, 0o600);
  await chmod(workspaceChartPath, 0o600);
  await execFile(helm, ["show", "chart", chartPath]);
  await execFile(helm, ["show", "chart", workspaceChartPath]);
  return { gateway: chartPath, workspace: workspaceChartPath };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentSandboxNode(node: unknown): node is AgentSandboxNodes["items"][number] {
  return (
    isRecord(node) &&
    isRecord(node.metadata) &&
    typeof node.metadata.name === "string" &&
    isRecord(node.status) &&
    isRecord(node.status.nodeInfo) &&
    typeof node.status.nodeInfo.operatingSystem === "string" &&
    typeof node.status.nodeInfo.architecture === "string"
  );
}

function parseAgentSandboxNodes(stdout: string): AgentSandboxNodes {
  const nodes: unknown = JSON.parse(stdout);
  if (!isRecord(nodes) || !Array.isArray(nodes.items) || !nodes.items.every(isAgentSandboxNode)) {
    throw new Error(
      "OpenShell bootstrap requires a kubectl node list with node platform information.",
    );
  }
  return { items: nodes.items };
}

async function installAgentSandbox(
  execFile: ExecuteFile,
  kubectl: string,
  cluster: Cluster,
  directory: string,
  registerImage: RegisterControllerImage,
): Promise<void> {
  const manifestPath = await downloadPinnedArtifact({
    artifact: {
      name: "Agent Sandbox",
      version: agentSandboxVersion,
      url: agentSandboxManifestUrl(),
      path: `agent-sandbox-${agentSandboxVersion}.yaml`,
      sha256: agentSandboxManifestSha256,
    },
    directory,
  });
  const nodes = parseAgentSandboxNodes(
    (await execFile(kubectl, kubectlArgs(cluster, ["get", "nodes", "-o", "json"]))).stdout,
  );
  const localManifest = await preloadAgentSandboxController(manifestPath, nodes, registerImage);
  await execFile(kubectl, kubectlArgs(cluster, ["apply", "-f", localManifest]));
  await execFile(kubectl, kubectlArgs(cluster, ["get", "crd", "sandboxes.agents.x-k8s.io"]));
  await execFile(
    kubectl,
    kubectlArgs(cluster, [
      "rollout",
      "status",
      "deployment/agent-sandbox-controller",
      "--namespace",
      "agent-sandbox-system",
      "--timeout=180s",
    ]),
  );
}

function assertRuntimeSmokeImage(image: string | undefined): string {
  assertImmutableImageReference(image, "OCC_TEST_KUBERNETES_AGENT_IMAGE");
  return image;
}

async function runOpenShellRuntimeSmoke(
  execFile: ExecuteFile,
  kubectl: string,
  cluster: Cluster,
  directory: string,
  runtimeClass: string,
  image: string,
): Promise<void> {
  const podName = "openshell-runtimeclass-smoke";
  const manifestPath = join(directory, `${podName}.yaml`);
  const manifest = [
    "apiVersion: v1",
    "kind: Pod",
    "metadata:",
    `  name: ${podName}`,
    "  labels:",
    "    app.kubernetes.io/name: openclaw-openshell-runtime-smoke",
    "spec:",
    "  restartPolicy: Never",
    `  runtimeClassName: ${runtimeClass}`,
    "  containers:",
    "    - name: smoke",
    `      image: ${JSON.stringify(image)}`,
    "      imagePullPolicy: Never",
    "      command:",
    "        - /bin/sh",
    "        - -c",
    "        - echo openshell-runtimeclass-smoke",
    "",
  ].join("\n");
  await rm(manifestPath, { force: true });
  await writeFile(manifestPath, manifest, { mode: 0o600 });
  await chmod(manifestPath, 0o600);
  try {
    await execFile(kubectl, kubectlArgs(cluster, ["apply", "-f", manifestPath]));
    await execFile(
      kubectl,
      kubectlArgs(cluster, [
        "wait",
        "--for=jsonpath={.status.phase}=Succeeded",
        `pod/${podName}`,
        "--timeout=120s",
      ]),
    );
  } catch (error) {
    const details = await execFile(
      kubectl,
      kubectlArgs(cluster, ["describe", "pod", podName]),
    ).then(commandDetails, commandDetails);
    throw new Error(
      `OpenShell Kubernetes RuntimeClass smoke pod failed for RuntimeClass ${runtimeClass}: ${commandField(error, "message") ?? String(error)}${
        details ? `\n${details}` : ""
      }`,
      { cause: error },
    );
  } finally {
    await execFile(
      kubectl,
      kubectlArgs(cluster, ["delete", "pod", podName, "--ignore-not-found=true", "--wait=false"]),
    ).catch(() => undefined);
  }
}

async function ensureRuntimeClass(
  execFile: ExecuteFile,
  kubectl: string,
  cluster: Cluster,
  directory: string,
  runtimeClass: string,
  handler: string,
): Promise<void> {
  const manifestPath = join(directory, `${runtimeClass}-runtimeclass.yaml`);
  const manifest = [
    "apiVersion: node.k8s.io/v1",
    "kind: RuntimeClass",
    "metadata:",
    `  name: ${runtimeClass}`,
    `handler: ${handler}`,
    "",
  ].join("\n");
  await rm(manifestPath, { force: true });
  await writeFile(manifestPath, manifest, { mode: 0o600 });
  await chmod(manifestPath, 0o600);
  await execFile(kubectl, kubectlArgs(cluster, ["apply", "-f", manifestPath]));
  await execFile(
    kubectl,
    kubectlArgs(cluster, ["get", "runtimeclass", runtimeClass, "-o", "json"]),
  );
}

async function assertKubernetesRuntimeHandlerAvailable(
  execFile: ExecuteFile,
  docker: string,
  cluster: Cluster,
  handler: string,
): Promise<void> {
  const result = await execFile(docker, [
    "exec",
    `k3d-${cluster.name}-server-0`,
    "sh",
    "-c",
    "cat /var/lib/rancher/k3s/agent/etc/containerd/config.toml /var/lib/rancher/k3s/agent/etc/containerd/config.toml.tmpl /var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.tmpl 2>/dev/null || true",
  ]);
  const runtimeHandlerPattern = new RegExp(
    `runtimes\\.(?:'|")?${escapeRegExp(handler)}(?:'|")?\\]`,
  );
  if (!runtimeHandlerPattern.test(result.stdout)) {
    throw new Error(
      `OpenShell requires the k3d node containerd runtime handler "${handler}" before this lane can run. The selected k3d node does not advertise that handler in its containerd configuration.`,
    );
  }
}

async function acquireKubectl(
  execFile: ExecuteFile,
  directory: string,
  platform: string,
  arch: string,
  downloadArtifact: DownloadArtifact,
): Promise<string> {
  const asset = selectKubectlAsset(platform, arch);
  const binDirectory = join(directory, "bin");
  await ensurePrivateDirectory(binDirectory);
  const kubectlPath = join(binDirectory, `${asset.name}-${kubectlVersion}`);
  assertInsideDirectory(binDirectory, kubectlPath, "kubectl binary");
  await downloadArtifact(kubectlReleaseUrl(asset), kubectlPath, asset.sha256);
  await chmod(kubectlPath, 0o700);
  await execFile(kubectlPath, ["version", "--client=true"]);
  return kubectlPath;
}

function podSecurityAdmissionConfiguration(runtimeClass: string): string {
  return [
    "apiVersion: apiserver.config.k8s.io/v1",
    "kind: AdmissionConfiguration",
    "plugins:",
    "  - name: PodSecurity",
    "    configuration:",
    "      apiVersion: pod-security.admission.config.k8s.io/v1",
    "      kind: PodSecurityConfiguration",
    "      defaults:",
    "        enforce: privileged",
    "        enforce-version: latest",
    "        audit: privileged",
    "        audit-version: latest",
    "        warn: privileged",
    "        warn-version: latest",
    "      exemptions:",
    "        usernames: []",
    "        runtimeClasses:",
    `          - ${runtimeClass}`,
    "        namespaces: []",
    "",
  ].join("\n");
}

async function prepareOpenShellPodSecurityAdmission({
  directory,
  runtimeClass,
}: {
  directory: string;
  runtimeClass: string;
}) {
  assertKubernetesName(runtimeClass, "OpenShell RuntimeClass");
  if (typeof directory !== "string" || directory.length === 0) {
    throw new Error("OpenShell Pod Security admission directory must be provided.");
  }
  if (!isAbsolute(directory)) {
    throw new Error("OpenShell Pod Security admission directory must be absolute.");
  }
  const root = resolve(directory);
  await assertPrivateDirectory(await stat(root), root);
  const path = join(root, podSecurityAdmissionConfigName);
  assertInsideDirectory(root, path, "OpenShell Pod Security admission configuration");
  await writeFile(path, podSecurityAdmissionConfiguration(runtimeClass), { mode: 0o600 });
  await chmod(path, 0o600);
  return {
    path,
    containerPath: podSecurityAdmissionContainerPath,
    k3dArgs: [
      "--volume",
      `${path}:${podSecurityAdmissionContainerPath}:ro@server:0`,
      "--k3s-arg",
      `--kube-apiserver-arg=admission-control-config-file=${podSecurityAdmissionContainerPath}@server:0`,
    ],
  };
}

function violatingPodSecurityManifest(namespace: string, runtimeClass?: string): string {
  return [
    "apiVersion: v1",
    "kind: Pod",
    "metadata:",
    "  name: openshell-psa-violation",
    `  namespace: ${namespace}`,
    "spec:",
    "  restartPolicy: Never",
    ...(runtimeClass ? [`  runtimeClassName: ${runtimeClass}`] : []),
    "  containers:",
    "    - name: probe",
    "      image: docker.io/library/busybox:1.36",
    "      command:",
    "        - sh",
    "        - -c",
    "        - 'true'",
    "      securityContext:",
    "        privileged: true",
    "",
  ].join("\n");
}

function commandField(value: unknown, field: "stdout" | "stderr" | "message"): string | undefined {
  if (isRecord(value)) {
    const fieldValue = value[field];
    if (typeof fieldValue === "string") {
      return fieldValue;
    }
  }
  return undefined;
}

function commandDetails(value: unknown): string {
  return [
    commandField(value, "stdout"),
    commandField(value, "stderr"),
    commandField(value, "message"),
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function assertOpenShellPodSecurityAdmissionExemption(
  execFile: ExecuteFile,
  kubectl: string,
  cluster: Cluster,
  directory: string,
  runtimeClass: string,
): Promise<void> {
  const namespace = "openshell-psa-probe";
  const rejectedManifestPath = join(directory, "openshell-psa-restricted-rejection.yaml");
  const exemptManifestPath = join(directory, "openshell-psa-runtimeclass-exemption.yaml");
  assertInsideDirectory(directory, rejectedManifestPath, "OpenShell Pod Security rejection probe");
  assertInsideDirectory(directory, exemptManifestPath, "OpenShell Pod Security exemption probe");
  await writeFile(rejectedManifestPath, violatingPodSecurityManifest(namespace), { mode: 0o600 });
  await chmod(rejectedManifestPath, 0o600);
  await writeFile(exemptManifestPath, violatingPodSecurityManifest(namespace, runtimeClass), {
    mode: 0o600,
  });
  await chmod(exemptManifestPath, 0o600);

  try {
    await execFile(kubectl, kubectlArgs(cluster, ["create", "namespace", namespace]));
    await execFile(
      kubectl,
      kubectlArgs(cluster, [
        "label",
        "namespace",
        namespace,
        "pod-security.kubernetes.io/enforce=restricted",
        "pod-security.kubernetes.io/enforce-version=latest",
        "--overwrite",
      ]),
    );

    let restrictedRejection: unknown;
    try {
      await execFile(
        kubectl,
        kubectlArgs(cluster, ["apply", "--dry-run=server", "-f", rejectedManifestPath]),
      );
    } catch (error) {
      restrictedRejection = error;
    }
    const details = commandDetails(restrictedRejection);
    if (!restrictedRejection) {
      throw new Error(
        "OpenShell Pod Security admission probe unexpectedly admitted a restricted-violating Pod without the selected RuntimeClass.",
      );
    }
    if (!/violates PodSecurity ["']restricted/.test(details)) {
      throw new Error(
        `OpenShell Pod Security admission probe expected a restricted PodSecurity rejection without RuntimeClass, but received: ${details}`,
      );
    }

    await execFile(
      kubectl,
      kubectlArgs(cluster, ["apply", "--dry-run=server", "-f", exemptManifestPath]),
    );
  } finally {
    await execFile(
      kubectl,
      kubectlArgs(cluster, [
        "delete",
        "namespace",
        namespace,
        "--ignore-not-found=true",
        "--wait=false",
      ]),
    ).catch(() => undefined);
  }
}

async function prepareOpenShellClusterBootstrap({
  directory,
  execFile,
  env = process.env,
  hostPlatform = process.platform,
  hostArch = process.arch,
  runtimeClass = env.OCC_TEST_OPENSHELL_RUNTIME_CLASS ?? "openshell-sandbox",
  runtimeHandler = env.OCC_TEST_OPENSHELL_RUNTIME_HANDLER ?? "runc",
  downloadArtifact = downloadVerified,
}: {
  directory: string;
  execFile: ExecuteFile;
  env?: Environment;
  hostPlatform?: string;
  hostArch?: string;
  runtimeClass?: string;
  runtimeHandler?: string;
  downloadArtifact?: DownloadArtifact;
}) {
  if (typeof execFile !== "function") {
    throw new Error("OpenShell cluster bootstrap requires execFile.");
  }
  assertKubernetesName(runtimeClass, "OpenShell RuntimeClass");
  assertRuntimeHandler(runtimeHandler);

  if (typeof directory !== "string" || directory.length === 0) {
    throw new Error("OpenShell cluster bootstrap directory must be provided.");
  }
  if (!isAbsolute(directory)) {
    throw new Error("OpenShell cluster bootstrap directory must be absolute.");
  }
  const root = resolve(directory);
  await assertPrivateDirectory(await stat(root), root);

  const kubectl = await acquireKubectl(execFile, root, hostPlatform, hostArch, downloadArtifact);

  return {
    k3sImage,
    runtimeClass,
    runtimeHandler,
    kubectl,
    kubectlVersion,
  };
}

async function validateOpenShellSelection(
  env: Environment,
  execFile: ExecuteFile,
  snapshotParent?: string,
) {
  const releasedImages = {
    gateway: openShellGatewayImage,
    sandbox: openShellSandboxImage,
    supervisor: openShellSupervisorImage,
  };
  for (const role of ["gateway", "sandbox", "supervisor"] as const) {
    const name = `OCC_TEST_OPENSHELL_${role.toUpperCase()}_IMAGE`;
    assertImmutableImageReference(env[name] || releasedImages[role], name);
  }
  const candidate = selectOpenShellCandidate(env, releasedImages);
  if (candidate) {
    return await verifyOpenShellCandidate(candidate, {
      execFile,
      docker: env.OCC_DOCKER_BIN ?? "docker",
      helm: env.OCC_HELM_BIN ?? "helm",
      ...(snapshotParent === undefined ? {} : { snapshotParent }),
    });
  }
  return candidate;
}

async function prepareOpenShell({
  cluster,
  execFile,
  registerImage,
  env = process.env,
}: {
  cluster: Cluster;
  execFile: ExecuteFile;
  registerImage: RegisterImage;
  env?: Environment;
}) {
  const selectedCluster = assertCluster(cluster);
  if (typeof execFile !== "function") {
    throw new Error("OpenShell bootstrap requires execFile.");
  }
  if (typeof registerImage !== "function") {
    throw new Error("OpenShell bootstrap requires a registerImage callback.");
  }

  // Keep verified candidate charts under the owned cluster directory for lane cleanup.
  assertPrivateDirectory(await lstat(selectedCluster.directory), selectedCluster.directory);
  const candidate = await validateOpenShellSelection(env, execFile, selectedCluster.directory);
  const directory = join(selectedCluster.directory, "openshell");
  await ensurePrivateDirectory(directory);

  const kubectl = env.OCC_KUBECTL_BIN ?? "kubectl";
  const helm = env.OCC_HELM_BIN ?? "helm";
  const docker = env.OCC_DOCKER_BIN ?? "docker";
  const runtimeClass = env.OCC_TEST_OPENSHELL_RUNTIME_CLASS ?? "openshell-sandbox";
  const runtimeHandler = env.OCC_TEST_OPENSHELL_RUNTIME_HANDLER ?? "runc";
  const gatewaySourceImage = env.OCC_TEST_OPENSHELL_GATEWAY_IMAGE || openShellGatewayImage;
  const sandboxSourceImage = env.OCC_TEST_OPENSHELL_SANDBOX_IMAGE || openShellSandboxImage;
  const supervisorSourceImage = env.OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE || openShellSupervisorImage;
  assertKubernetesName(runtimeClass, "OpenShell RuntimeClass");
  assertRuntimeHandler(runtimeHandler);

  await execFile(kubectl, kubectlArgs(selectedCluster, ["version", "--client=true"]));
  await execFile(helm, ["version", "--short"]);

  await ensureRuntimeClass(
    execFile,
    kubectl,
    selectedCluster,
    directory,
    runtimeClass,
    runtimeHandler,
  );
  await assertKubernetesRuntimeHandlerAvailable(execFile, docker, selectedCluster, runtimeHandler);
  await assertOpenShellPodSecurityAdmissionExemption(
    execFile,
    kubectl,
    selectedCluster,
    directory,
    runtimeClass,
  );
  await runOpenShellRuntimeSmoke(
    execFile,
    kubectl,
    selectedCluster,
    directory,
    runtimeClass,
    assertRuntimeSmokeImage(env.OCC_TEST_KUBERNETES_AGENT_IMAGE),
  );

  const charts = candidate
    ? { gateway: candidate.gatewayChart, workspace: candidate.workspaceChart }
    : await acquireOpenShellCharts(execFile, helm, directory);
  await installAgentSandbox(execFile, kubectl, selectedCluster, directory, registerImage);

  const gatewayImage = chartDeployableImageReference(
    await registerImage(gatewaySourceImage, "OCC_TEST_OPENSHELL_GATEWAY_IMAGE"),
    "OCC_TEST_OPENSHELL_GATEWAY_IMAGE",
  );
  const supervisorImage = chartDeployableImageReference(
    await registerImage(supervisorSourceImage, "OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE"),
    "OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE",
  );
  const sandboxImage = chartDeployableImageReference(
    await registerImage(sandboxSourceImage, "OCC_TEST_OPENSHELL_SANDBOX_IMAGE"),
    "OCC_TEST_OPENSHELL_SANDBOX_IMAGE",
  );

  return {
    OCC_TEST_OPENSHELL_K3D_REAL: "1",
    OCC_TEST_OPENSHELL_HELM: helm,
    OCC_TEST_OPENSHELL_HELM_CHART: charts.gateway,
    OCC_TEST_OPENSHELL_WORKSPACE_HELM_CHART: charts.workspace,
    OCC_TEST_OPENSHELL_CHART_VERSION: candidate?.gatewayAppVersion ?? openShellVersion,
    ...(candidate && { OCC_TEST_OPENSHELL_SOURCE_REVISION: candidate.sourceRevision }),
    OCC_TEST_OPENSHELL_GATEWAY_IMAGE: gatewayImage,
    OCC_TEST_OPENSHELL_SANDBOX_IMAGE: sandboxImage,
    OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE: supervisorImage,
    OCC_TEST_OPENSHELL_RUNTIME_CLASS: runtimeClass,
  };
}

export {
  agentSandboxVersion,
  k3sImage,
  kubectlVersion,
  openShellRevision,
  openShellVersion,
  prepareOpenShell,
  prepareOpenShellClusterBootstrap,
  prepareOpenShellPodSecurityAdmission,
  selectKubectlAsset,
  validateOpenShellSelection,
};

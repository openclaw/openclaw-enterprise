import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isIPv6 } from "node:net";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { assertInsideDirectory } from "../lib/assert-inside-directory.ts";
import type { NativeImageSelection } from "./k3d-image-admission.ts";

interface ArtifactSource {
  name: string;
  url: string | URL | Request;
}

interface PinnedArtifact extends ArtifactSource {
  version: string;
  path: string;
  sha256: string;
}

interface ArtifactDownload {
  artifact: PinnedArtifact;
  directory: string;
}

interface FetchRetryOptions {
  attempts?: number;
  firstDelayMs?: number;
  maxDelayMs?: number;
  budgetMs?: number;
  attemptTimeoutMs?: number;
}

interface RoutingCluster {
  name: string;
  directory: string;
  kubeconfig: string;
  context: string;
  kubectl?: string;
  disabledK3sAddons?: string | readonly string[] | null | undefined;
}

// The command's completion or rejection matters. Its output is unused.
type ExecFile = (command: string, args: string[]) => void;

interface CertManagerMirror {
  prefix: string;
  platform: string;
  registerImage: (
    image: string,
    description: string,
    selection: NativeImageSelection,
  ) => Promise<string>;
}

interface RoutingPreparation {
  cluster: RoutingCluster;
  execFile: ExecFile;
  downloadArtifact?: (request: ArtifactDownload) => string | PromiseLike<string>;
  certManagerMirror?: CertManagerMirror;
}

const envoyGateway = Object.freeze({
  name: "Envoy Gateway",
  version: "v1.6.7",
  url: "https://github.com/envoyproxy/gateway/releases/download/v1.6.7/install.yaml",
  sha256: "9a250c698d78b92c670d9d2bd6bd54615f1dee41ddd520ece9704edf63088df8",
  path: "envoy-gateway-v1.6.7-install.yaml",
  namespace: "envoy-gateway-system",
  deployment: "envoy-gateway",
  podSelector: "app.kubernetes.io/name=gateway-helm",
});

const certManager = Object.freeze({
  name: "cert-manager",
  version: "v1.18.4",
  url: "https://github.com/cert-manager/cert-manager/releases/download/v1.18.4/cert-manager.yaml",
  sha256: "aff085b4f0126f67372e3a02cb18feb70eed37dbd4de01973a159e6c13482f83",
  path: "cert-manager-v1.18.4.yaml",
  namespace: "cert-manager",
  deployments: ["cert-manager", "cert-manager-cainjector", "cert-manager-webhook"],
});

const certManagerAmd64Images = [
  {
    name: "cert-manager-cainjector",
    manifestDigest: "sha256:7d76b4378f6fd5521322e9836b655f16a4adc3b25a17cd11f85a174193459513",
    configDigest: "sha256:ad1b7e44d0855e7f33a846363dc693142b98cb73c7e2f9adadf6bb01aa8086bd",
  },
  {
    name: "cert-manager-controller",
    manifestDigest: "sha256:c05a0e8f600db90be597b88ecd922b469e238846647779ce9ab1fd919ff55866",
    configDigest: "sha256:df7ffea66a7c13783be15587323d51038564d4880cc6b30ca09f3937f2ddc251",
  },
  {
    name: "cert-manager-webhook",
    manifestDigest: "sha256:02cb2d48cea58f1d8ae8ac4438a92c8c3e2e9892c3f53ad59f047a07e6d5f2e6",
    configDigest: "sha256:f5665e37afc016001c1eb87bed62694bdea9aa05cac27468f43fbfe2633cda6d",
  },
];

const gatewayApiCrds = Object.freeze([
  "gatewayclasses.gateway.networking.k8s.io",
  "gateways.gateway.networking.k8s.io",
  "httproutes.gateway.networking.k8s.io",
  "referencegrants.gateway.networking.k8s.io",
]);

const envoyGatewayCrds = Object.freeze(["securitypolicies.gateway.envoyproxy.io"]);
const certManagerCrds = Object.freeze([
  "certificates.cert-manager.io",
  "issuers.cert-manager.io",
  "clusterissuers.cert-manager.io",
]);

const caSubject = "/CN=OCC disposable routing test CA";

function assertCluster(cluster: RoutingCluster): RoutingCluster {
  assert.equal(typeof cluster?.name, "string", "cluster.name must be provided.");
  assert.match(
    cluster.name,
    /^openclaw-k8s-[a-z0-9-]+$/,
    "cluster.name must be an owned CI k3d cluster.",
  );
  assert.equal(typeof cluster.directory, "string", "cluster.directory must be provided.");
  assert.equal(typeof cluster.kubeconfig, "string", "cluster.kubeconfig must be provided.");
  assert.equal(typeof cluster.context, "string", "cluster.context must be provided.");

  const directory = resolve(cluster.directory);
  assert.ok(isAbsolute(directory), "cluster.directory must resolve to an absolute path.");
  assert.equal(
    basename(directory).startsWith(`${cluster.name}-`),
    true,
    "cluster.directory must be the private directory owned by the selected cluster.",
  );
  assert.equal(
    resolve(cluster.kubeconfig),
    join(directory, "kubeconfig"),
    "cluster.kubeconfig must be inside the selected cluster directory.",
  );
  assert.equal(
    cluster.context,
    `k3d-${cluster.name}`,
    "cluster.context must select the owned k3d context.",
  );
  return { ...cluster, directory, kubeconfig: resolve(cluster.kubeconfig) };
}

async function kubectl(cluster: RoutingCluster, execFile: ExecFile, ...args: string[]) {
  await execFile(cluster.kubectl ?? process.env.OCC_KUBECTL_BIN ?? "kubectl", [
    "--kubeconfig",
    cluster.kubeconfig,
    "--context",
    cluster.context,
    ...args,
  ]);
}

async function writePrivateFile(path: string, data: string | Uint8Array) {
  const mode = 0o600;
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, data, { mode });
  await chmod(temp, mode);
  await rename(temp, path);
  await chmod(path, mode);
}

function sha256(data: Uint8Array) {
  return createHash("sha256").update(data).digest("hex");
}

const manifestMaximumBytes = 32 * 1024 * 1024;

class ManifestSizeError extends Error {
  constructor() {
    super("manifest exceeds its size limit");
  }
}

async function readManifestBytes(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
  let bytes = Buffer.alloc(0);
  let length = 0;
  for await (const chunk of chunks) {
    if (chunk.length > manifestMaximumBytes - length) {
      throw new ManifestSizeError();
    }
    const nextLength = length + chunk.length;
    if (nextLength > bytes.length) {
      const capacity = Math.min(
        manifestMaximumBytes,
        Math.max(65536, nextLength, bytes.length * 2),
      );
      const grown = Buffer.allocUnsafe(capacity);
      bytes.copy(grown, 0, 0, length);
      bytes = grown;
    }
    bytes.set(chunk, length);
    length = nextLength;
  }
  return bytes.subarray(0, length);
}

const transientHttpStatus = /^(?:408|429|5\d\d)$/;
// Connection, DNS, reset and timeout errors, matching the curl exit codes
// download-pinned.sh retries. TLS certificate errors and bad URLs are not here.
const transientNetworkCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

function hasErrorProperty<Key extends "name" | "cause" | "errors" | "code">(
  value: unknown,
  key: Key,
): value is Record<Key, unknown> {
  return (
    value !== null && (typeof value === "object" || typeof value === "function") && key in value
  );
}

function errorCode(error: unknown) {
  return hasErrorProperty(error, "code") ? error.code : undefined;
}

export function isTransientFetchError(error: unknown): boolean {
  if (hasErrorProperty(error, "name") && error.name === "TimeoutError") {
    return true;
  }
  // fetch wraps the socket error in `cause`; a multi-address connect failure
  // is an AggregateError that lists one error per address.
  const cause = hasErrorProperty(error, "cause") ? error.cause : undefined;
  const errors = hasErrorProperty(cause, "errors") ? cause.errors : undefined;
  const entries: readonly unknown[] = Array.isArray(errors) ? errors : [];
  return [cause, ...entries].some((entry) => {
    const code = errorCode(entry);
    return typeof code === "string" && transientNetworkCodes.has(code);
  });
}

// Same retry rule as scripts/ci/download-pinned.sh: transient network errors
// and HTTP 408/429/5xx are retried (eight attempts, backoff doubling to a
// 20 s cap; schedule only when the delay fits the 120 s budget). Other errors
// and HTTP statuses fail at once. The caller verifies the checksum, never retried.
export async function fetchPinnedBytes(
  artifact: ArtifactSource,
  {
    attempts = 8,
    firstDelayMs = 2_000,
    maxDelayMs = 20_000,
    budgetMs = 120_000,
    attemptTimeoutMs = 60_000,
  }: FetchRetryOptions = {},
) {
  const started = Date.now();
  let delayMs = Math.min(firstDelayMs, maxDelayMs);
  for (let attempt = 1; ; attempt += 1) {
    let failure: string;
    let cause: unknown;
    let transient: boolean;
    try {
      const response = await fetch(artifact.url, {
        signal: AbortSignal.timeout(attemptTimeoutMs),
      });
      if (response.ok) {
        return await readManifestBytes(response.body ?? []);
      }
      await response.body?.cancel();
      failure = `HTTP ${response.status}`;
      transient = transientHttpStatus.test(String(response.status));
    } catch (error) {
      cause = error;
      const code = hasErrorProperty(error, "cause") ? errorCode(error.cause) : undefined;
      const name = hasErrorProperty(error, "name") ? error.name : undefined;
      if (error instanceof ManifestSizeError) {
        failure = "manifest exceeds its 32 MiB size limit";
      } else if (typeof code === "string" || typeof code === "number") {
        failure = String(code);
      } else {
        failure = typeof name === "string" ? name : "network error";
      }
      transient = isTransientFetchError(error);
    }
    if (!transient || attempt >= attempts || Date.now() - started + delayMs > budgetMs) {
      throw new Error(`${artifact.name} download failed: ${failure} after ${attempt} attempt(s).`, {
        cause,
      });
    }
    console.error(
      `${artifact.name} download failed (${failure}); retrying in ${delayMs} ms (attempt ${attempt + 1}/${attempts}).`,
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    delayMs = Math.min(delayMs * 2, maxDelayMs);
  }
}

export async function downloadPinnedArtifact({ artifact, directory }: ArtifactDownload) {
  const destination = join(directory, artifact.path);
  assertInsideDirectory(directory, destination, `${artifact.name} manifest`);
  let cached: FileHandle | undefined;
  try {
    cached = await open(
      destination,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = await cached.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1) {
      throw new Error("cached manifest must be an owned regular file");
    }
    if (info.size > manifestMaximumBytes) {
      throw new ManifestSizeError();
    }
    const existing = await readManifestBytes(cached.createReadStream({ autoClose: false }));
    if (sha256(existing) === artifact.sha256) {
      await cached.chmod(0o600);
      return destination;
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  } finally {
    await cached?.close();
  }

  const data = await fetchPinnedBytes(artifact);
  const actual = sha256(data);
  if (actual !== artifact.sha256) {
    throw new Error(
      `${artifact.name} ${artifact.version} SHA256 mismatch: expected ${artifact.sha256}, got ${actual}.`,
    );
  }
  await writePrivateFile(destination, data);
  return destination;
}

export function assertCertManagerMirrorPrefix(prefix: string) {
  const [registry = "", ...repository] = prefix.split("/");
  const [, host, port] =
    /^(\[[a-f0-9:.]+\]|[a-z0-9.-]+)(?::([1-9]\d{0,4}))?$/u.exec(registry) ?? [];
  const ipv6 = host?.startsWith("[") && isIPv6(host.slice(1, -1));
  if (
    !host ||
    !(
      ipv6 ||
      host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
    ) ||
    !(ipv6 || host === "localhost" || host.includes(".") || port) ||
    (port !== undefined && Number(port) > 65535) ||
    repository.length === 0 ||
    !repository.every((component) => /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/u.test(component))
  ) {
    throw new Error(
      "OCC_CI_CERT_MANAGER_IMAGE_MIRROR must be a qualified registry/repository prefix.",
    );
  }
}

async function prepareMirroredCertManagerManifest(
  cluster: RoutingCluster,
  directory: string,
  originalPath: string,
  { prefix, platform, registerImage }: CertManagerMirror,
) {
  const original = await readFile(originalPath, "utf8");
  // Match the container blocks of the pinned release without reserializing its other resources.
  const containers = [
    ...original.matchAll(
      /^ {6}containers:\n {8}- name: ([a-z0-9-]+)\n {10}image: "([^"\n]+)"\n {10}imagePullPolicy: IfNotPresent$/gmu,
    ),
  ];
  const imageFields = original.match(/^[ \t]*image(?:PullPolicy)?:/gmu);
  if (
    containers.length !== certManagerAmd64Images.length ||
    imageFields?.length !== containers.length * 2
  ) {
    throw new Error(
      "The pinned cert-manager manifest has unexpected container images or pull policies.",
    );
  }
  const inputs = certManagerAmd64Images.map(({ name, manifestDigest, configDigest }) => {
    const upstream = `quay.io/jetstack/${name}:${certManager.version}`;
    const block = containers.find(
      ([, container, image]) => container === name && image === upstream,
    );
    if (!block) {
      throw new Error(
        `The pinned cert-manager manifest has an unexpected container image for ${name}.`,
      );
    }
    return { name, manifestDigest, configDigest, upstream, block: block[0] };
  });

  let prepared = original;
  const localPrefix = `localhost/${cluster.name}/`;
  for (const { name, manifestDigest, configDigest, upstream, block } of inputs) {
    const reference = await registerImage(`${prefix}/${name}@${manifestDigest}`, name, {
      platform,
      configDigest,
    });
    if (
      typeof reference !== "string" ||
      !reference.startsWith(localPrefix) ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*@sha256:[a-f0-9]{64}$/u.test(reference.slice(localPrefix.length))
    ) {
      throw new Error(`${name} admission did not return an immutable alias for ${cluster.name}.`);
    }
    prepared = prepared.replace(
      block,
      block
        .replace(`image: "${upstream}"`, `image: "${reference}"`)
        .replace("IfNotPresent", "Never"),
    );
  }
  const preparedPath = join(directory, `cert-manager-${certManager.version}-prepared.yaml`);
  await writePrivateFile(preparedPath, prepared);
  return preparedPath;
}

async function createPrivateTestCa(directory: string, execFile: ExecFile) {
  const caDirectory = join(directory, "test-ca");
  assertInsideDirectory(directory, caDirectory, "test CA directory");
  await rm(caDirectory, { recursive: true, force: true });
  await mkdir(caDirectory, { recursive: true, mode: 0o700 });
  await chmod(caDirectory, 0o700);

  const certPath = join(caDirectory, "cert.pem");
  const keyPath = join(caDirectory, "key.pem");
  await execFile("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-days",
    "2",
    "-nodes",
    "-subj",
    caSubject,
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
    "-keyout",
    keyPath,
    "-out",
    certPath,
  ]);
  await chmod(certPath, 0o600);
  await chmod(keyPath, 0o600);
  return { certPath, keyPath };
}

async function waitForCrds(cluster: RoutingCluster, execFile: ExecFile, crds: readonly string[]) {
  for (const crd of crds) {
    await kubectl(cluster, execFile, "wait", "--for=create", `crd/${crd}`, "--timeout=180s");
    await kubectl(
      cluster,
      execFile,
      "wait",
      "--for=condition=Established",
      `crd/${crd}`,
      "--timeout=180s",
    );
  }
}

async function rolloutDeployments(
  cluster: RoutingCluster,
  execFile: ExecFile,
  namespace: string,
  deployments: readonly string[],
) {
  for (const deployment of deployments) {
    await kubectl(
      cluster,
      execFile,
      "rollout",
      "status",
      `deployment/${deployment}`,
      "--namespace",
      namespace,
      "--timeout=300s",
    );
  }
}

async function applyControllers(
  cluster: RoutingCluster,
  execFile: ExecFile,
  certManagerManifest: string,
  envoyGatewayManifest: string,
) {
  await kubectl(cluster, execFile, "apply", "-f", certManagerManifest);
  await waitForCrds(cluster, execFile, certManagerCrds);
  await rolloutDeployments(cluster, execFile, certManager.namespace, certManager.deployments);

  const envoyControllerManifest = join(
    dirname(envoyGatewayManifest),
    `${basename(envoyGatewayManifest, ".yaml")}-controller.yaml`,
  );
  const envoyDocuments = (await readFile(envoyGatewayManifest, "utf8"))
    .replace("extensionApis: {}", "extensionApis:\n      enableEnvoyPatchPolicy: true")
    .split(/^---\s*$/mu)
    .filter((document) => {
      if (!/^kind:\s*CustomResourceDefinition\s*$/mu.test(document)) {
        return true;
      }
      const specOffset = document.search(/^spec:\s*$/mu);
      const metadata = specOffset === -1 ? document : document.slice(0, specOffset);
      const name = /^ {2}name:\s*(\S+)\s*$/mu.exec(metadata)?.[1];
      return !name?.endsWith(".gateway.networking.k8s.io");
    });
  await writePrivateFile(envoyControllerManifest, `${envoyDocuments.join("\n---\n")}\n`);
  await kubectl(cluster, execFile, "apply", "--server-side", "-f", envoyControllerManifest);
  await waitForCrds(cluster, execFile, [...gatewayApiCrds, ...envoyGatewayCrds]);
  await rolloutDeployments(cluster, execFile, envoyGateway.namespace, [envoyGateway.deployment]);
}

export async function prepareGatewayRouting({
  cluster,
  execFile,
  downloadArtifact = downloadPinnedArtifact,
  certManagerMirror,
}: RoutingPreparation) {
  assert.equal(typeof execFile, "function", "prepareGatewayRouting requires an execFile callback.");
  const ownedCluster = assertCluster(cluster);
  // K3s installs the Gateway API CRDs with Traefik, and applyControllers waits for them, so
  // a cluster created without it would wait out 180 s per CRD before failing.
  assert.ok(
    !ownedCluster.disabledK3sAddons?.includes("traefik"),
    "Gateway routing needs K3s's Traefik add-on, which this lane's cluster disables; remove the lane from lanesWithoutK3sAddons in scripts/ci/prepare.ts.",
  );
  if (certManagerMirror) {
    assertCertManagerMirrorPrefix(certManagerMirror.prefix);
    if (certManagerMirror.platform !== "linux/amd64") {
      throw new Error("The cert-manager image mirror requires linux/amd64 k3d nodes.");
    }
  }
  const directory = join(ownedCluster.directory, "gateway-routing");
  assertInsideDirectory(ownedCluster.directory, directory, "routing artifact directory");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  const [originalCertManagerManifest, envoyGatewayManifest] = await Promise.all([
    downloadArtifact({ artifact: certManager, directory }),
    downloadArtifact({ artifact: envoyGateway, directory }),
  ]);
  const certManagerManifest = certManagerMirror
    ? await prepareMirroredCertManagerManifest(
        ownedCluster,
        directory,
        originalCertManagerManifest,
        certManagerMirror,
      )
    : originalCertManagerManifest;
  const ca = await createPrivateTestCa(directory, execFile);
  await applyControllers(ownedCluster, execFile, certManagerManifest, envoyGatewayManifest);

  return {
    env: {
      OCC_TEST_GATEWAY_ROUTING_REAL: "1",
      OCC_TEST_ENVOY_GATEWAY_NAMESPACE: envoyGateway.namespace,
      OCC_TEST_CERT_MANAGER_NAMESPACE: certManager.namespace,
      OCC_TEST_GATEWAY_CA_CERT_PATH: ca.certPath,
      OCC_TEST_GATEWAY_CA_KEY_PATH: ca.keyPath,
      NODE_EXTRA_CA_CERTS: ca.certPath,
    },
    artifacts: {
      directory,
      ca,
      manifests: {
        certManager: originalCertManagerManifest,
        envoyGateway: envoyGatewayManifest,
      },
      pins: {
        certManager: {
          version: certManager.version,
          url: certManager.url,
          sha256: certManager.sha256,
        },
        envoyGateway: {
          version: envoyGateway.version,
          url: envoyGateway.url,
          sha256: envoyGateway.sha256,
        },
      },
      controllers: {
        certManager: {
          namespace: certManager.namespace,
          deployments: certManager.deployments,
        },
        envoyGateway: {
          namespace: envoyGateway.namespace,
          deployment: envoyGateway.deployment,
          podSelector: envoyGateway.podSelector,
        },
      },
      crds: [...certManagerCrds, ...gatewayApiCrds, ...envoyGatewayCrds],
    },
  };
}

export const gatewayRoutingPins = Object.freeze({
  certManager,
  envoyGateway,
});

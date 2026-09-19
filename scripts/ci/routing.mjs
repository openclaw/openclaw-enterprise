import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

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

function assertCluster(cluster) {
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

function assertInsideDirectory(parent, child, description) {
  const relativePath = relative(parent, resolve(child));
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`${description} must stay inside ${parent}.`);
  }
}

function namespacedKubectlArgs(cluster, args) {
  return ["--kubeconfig", cluster.kubeconfig, "--context", cluster.context, ...args];
}

async function kubectl(cluster, execFile, ...args) {
  return await execFile(
    process.env.OCC_KUBECTL_BIN ?? "kubectl",
    namespacedKubectlArgs(cluster, args),
  );
}

async function writePrivateFile(path, data, mode = 0o600) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, data, { mode });
  await chmod(temp, mode);
  await rename(temp, path);
  await chmod(path, mode);
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function downloadPinnedArtifact({ artifact, directory }) {
  const destination = join(directory, artifact.path);
  assertInsideDirectory(directory, destination, `${artifact.name} manifest`);
  try {
    const existing = await readFile(destination);
    if (sha256(existing) === artifact.sha256) {
      return destination;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const response = await fetch(artifact.url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw new Error(`${artifact.name} download failed: HTTP ${response.status}.`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  const actual = sha256(data);
  if (actual !== artifact.sha256) {
    throw new Error(
      `${artifact.name} ${artifact.version} SHA256 mismatch: expected ${artifact.sha256}, got ${actual}.`,
    );
  }
  await writePrivateFile(destination, data);
  return destination;
}

async function createPrivateTestCa({ directory, execFile }) {
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

async function waitForCrds(cluster, execFile, crds) {
  for (const crd of crds) {
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

async function rolloutDeployments(cluster, execFile, namespace, deployments) {
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

async function applyControllers({ cluster, execFile, certManagerManifest, envoyGatewayManifest }) {
  await kubectl(cluster, execFile, "apply", "-f", certManagerManifest);
  await waitForCrds(cluster, execFile, certManagerCrds);
  await rolloutDeployments(cluster, execFile, certManager.namespace, certManager.deployments);

  const envoyControllerManifest = join(
    dirname(envoyGatewayManifest),
    `${basename(envoyGatewayManifest, ".yaml")}-controller.yaml`,
  );
  const envoyDocuments = (await readFile(envoyGatewayManifest, "utf8"))
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

export async function prepareGatewayRouting({ cluster, execFile }) {
  assert.equal(typeof execFile, "function", "prepareGatewayRouting requires an execFile callback.");
  const ownedCluster = assertCluster(cluster);
  const directory = join(ownedCluster.directory, "gateway-routing");
  assertInsideDirectory(ownedCluster.directory, directory, "routing artifact directory");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  const [certManagerManifest, envoyGatewayManifest] = await Promise.all([
    downloadPinnedArtifact({ artifact: certManager, directory }),
    downloadPinnedArtifact({ artifact: envoyGateway, directory }),
  ]);
  const ca = await createPrivateTestCa({ directory, execFile });
  await applyControllers({
    cluster: ownedCluster,
    execFile,
    certManagerManifest,
    envoyGatewayManifest,
  });

  return {
    env: {
      OCC_TEST_GATEWAY_ROUTING_REAL: "1",
      OCC_TEST_SLACK_LIVE: "0",
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
        certManager: certManagerManifest,
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

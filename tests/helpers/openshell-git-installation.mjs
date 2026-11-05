import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import {
  openShellGitRetentionKind,
  projectOpenShellGitExpiryObservation,
  projectOpenShellGitRetention,
} from "../../scripts/ci/openshell-git-retention.mjs";
import { run } from "../fixtures/repository-credentials/process.mjs";
import { startSkipperPrivateGitOrigin } from "../fixtures/skipper-private-git-origin.mjs";
import { availablePort } from "./available-port.mjs";
import { localFirstAgentStack, ownFirstAgentWork } from "./local-first-agent-stack.mjs";
import { localOpenShellGatewayOptions } from "./local-openshell-gateway.mjs";
import { stopProcess } from "./stop-process.mjs";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const { loadYaml } = await import(require.resolve("@kubernetes/client-node"));
const { Agent, fetch } = require("undici");
const root = fileURLToPath(new URL("../../", import.meta.url));
const workerLabels = {
  "app.kubernetes.io/name": "openclaw-enterprise",
  "app.kubernetes.io/instance": "openclaw-enterprise",
  "app.kubernetes.io/component": "worker",
};
const supervisorLabels = {
  "openshell.ai/managed-by": "openshell",
  "openshell.ai/boundary-role": "supervisor",
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const selector = (labels) =>
  Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
const peer = (namespace, labels) => ({
  namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": namespace } },
  podSelector: { matchLabels: labels },
});

export function createOpenShellGitApi({ origin, key, signal, after }) {
  const base = new URL(origin);
  assert.ok(
    base.protocol === "http:" &&
      base.hostname === "127.0.0.1" &&
      base.port &&
      base.username === "" &&
      base.password === "" &&
      base.pathname === "/" &&
      base.search === "" &&
      base.hash === "",
    "Installed Git API requires its owned loopback origin",
  );
  // This key and Secret request bodies belong only to the disposable API. A
  // private dispatcher bypasses ambient proxies without altering other traffic.
  const dispatcher = new Agent();
  after(() => dispatcher.close());
  return async (method, path, body) => {
    const url = new URL(path, base);
    assert.equal(url.origin, base.origin, "Installed Git API path changed origin");
    const response = await fetch(url, {
      dispatcher,
      redirect: "error",
      method,
      headers: {
        "x-api-key": key,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`OCC ${method} ${path} returned HTTP ${response.status}`);
    }
    if (response.status === 204) {
      return undefined;
    }
    try {
      return (await response.json()).data;
    } catch {
      throw new Error(`OCC ${method} ${path} returned invalid JSON`);
    }
  };
}

async function waitUntil(description, operation, timeout, signal) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const result = await operation();
    if (result) {
      return result;
    }
    await delay(500, undefined, { signal });
  }
  throw new Error(`Timed out waiting for ${description}`);
}

// Keys remain in this private directory or worker-only Secrets. The image build
// context below receives only public certificates, never either signing key.
async function certificates(command, directory, originHost, authorityHost) {
  const caKey = join(directory, "ca.key");
  const caFile = join(directory, "ca.crt");
  await command("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-subj",
    "/CN=OCE isolated Git fixture",
    "-keyout",
    caKey,
    "-out",
    caFile,
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  const issue = async (name, hosts) => {
    const key = join(directory, `${name}.key`);
    const csr = join(directory, `${name}.csr`);
    const cert = join(directory, `${name}.crt`);
    const extensions = join(directory, `${name}.ext`);
    await writeFile(
      extensions,
      `subjectAltName=${hosts.map((host) => `DNS:${host}`).join(",")}\nextendedKeyUsage=serverAuth\n`,
      { mode: 0o600 },
    );
    await command("openssl", [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      `/CN=${hosts[0]}`,
      "-keyout",
      key,
      "-out",
      csr,
    ]);
    await command("openssl", [
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      caFile,
      "-CAkey",
      caKey,
      "-set_serial",
      `0x${randomBytes(16).toString("hex")}`,
      "-days",
      "2",
      "-extfile",
      extensions,
      "-out",
      cert,
    ]);
    return { key: await readFile(key, "utf8"), cert: await readFile(cert, "utf8") };
  };
  return {
    ca: await readFile(caFile, "utf8"),
    origin: await issue("origin", ["github.com", "api.github.com", originHost]),
    authority: await issue("authority", [authorityHost]),
  };
}

async function trustedSupervisor({ command, cleanup, directory, cluster, ca, checkpoint }) {
  // Read the same stock pin used by Local Setup rather than maintaining another
  // independent image version. Candidate supplier builds are rejected at entry.
  const source = await readFile(join(root, "internal/occdev/openshell.go"), "utf8");
  const parent = source.match(/openShellSupervisorImage\s*=\s*"([^"]+)"/)?.[1];
  assert.match(
    parent ?? "",
    /^ghcr\.io\/nvidia\/openshell\/supervisor:0\.1\.6@sha256:[a-f0-9]{64}$/,
  );
  const context = join(directory, "supervisor-trust");
  await mkdir(context, { mode: 0o700 });
  const extract = async (image, filename, destination) => {
    const container = (await command("docker", ["create", image])).trim();
    assert.match(container, /^[a-f0-9]{64}$/);
    try {
      await command("docker", ["cp", `${container}:${filename}`, destination]);
    } finally {
      await command("docker", ["rm", container]);
    }
  };
  const stockCertificates = join(directory, "stock-ca-certificates.crt");
  await extract(parent, "/etc/ssl/certs/ca-certificates.crt", stockCertificates);
  await extract(parent, "/openshell-supervisor", join(directory, "stock-supervisor"));
  // docker cp preserves the stock file's read-only mode. Build a new owned
  // bundle without changing the stock certificates or their permissions.
  await writeFile(
    join(context, "ca-certificates.crt"),
    Buffer.concat([await readFile(stockCertificates), Buffer.from(`\n${ca}`)]),
  );
  await writeFile(
    join(context, "Dockerfile"),
    `FROM ${parent}\nCOPY --chmod=0644 ca-certificates.crt /etc/ssl/certs/ca-certificates.crt\n`,
  );
  const tag = `oce-git-supervisor-${randomUUID()}:test`;
  await command("docker", ["build", "--network=none", "--tag", tag, context], { timeout: 120_000 });
  cleanup.push(() => command("docker", ["image", "rm", tag]));
  await extract(tag, "/openshell-supervisor", join(directory, "trusted-supervisor"));
  const binaryHash = hash(await readFile(join(directory, "stock-supervisor")));
  assert.equal(hash(await readFile(join(directory, "trusted-supervisor"))), binaryHash);
  await command("k3d", ["image", "import", "--cluster", cluster, tag], { timeout: 120_000 });
  const containerd = ["exec", `k3d-${cluster}-server-0`, "ctr", "-n", "k8s.io", "images"];
  const imported = (await command("docker", [...containerd, "list"]))
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .find(
      ([name]) =>
        name === tag || name === `docker.io/library/${tag}` || name === `docker.io/${tag}`,
    );
  assert.ok(imported, "the owned cluster must import the trust-only supervisor image");
  assert.match(imported[2], /^sha256:[a-f0-9]{64}$/);
  const importedRepository = imported[0].slice(0, imported[0].lastIndexOf(":"));
  const repository = importedRepository.includes("/")
    ? importedRepository
    : `docker.io/library/${importedRepository}`;
  const reference = `${repository}@${imported[2]}`;
  await command("docker", [...containerd, "tag", imported[0], reference]);
  const configDigest = (
    await command("docker", ["image", "inspect", "--format", "{{.Id}}", tag])
  ).trim();
  assert.match(configDigest, /^sha256:[a-f0-9]{64}$/);
  await checkpoint("supervisor-trust", { parent, reference, binaryHash, configDigest });
  const slash = repository.indexOf("/");
  return {
    reference,
    binaryHash,
    configDigest,
    image: {
      registry: repository.slice(0, slash),
      repository: repository.slice(slash + 1),
      digest: imported[2],
      tag: "",
      pullPolicy: "Never",
    },
  };
}

/** Installs the supported model + selected-repository path in its own k3d cluster. */
export function createOpenShellGitInstallation(t) {
  return ownFirstAgentWork(t)(installOpenShellGit(t));
}

async function installOpenShellGit(t) {
  const eventually = (description, operation, timeout = 120_000) =>
    waitUntil(description, operation, timeout, t.signal);
  let tearingDown = false;
  assert.equal(process.env.OCC_TEST_LOCAL_FIRST_AGENT_SANDBOX_DRIVER, "openshell");
  assert.equal(process.env.OCC_TEST_LOCAL_FIRST_AGENT_CONTROL_PLANE, "kubernetes");
  assert.ok(
    process.env.OPENAI_API_KEY?.trim(),
    "OPENAI_API_KEY is required for genuine native startup",
  );
  assert.equal(
    process.env.OCC_DEVELOPMENT_STATE_DIRECTORY,
    undefined,
    "this fixture requires its own disposable installation",
  );
  for (const name of [
    "GATEWAY_IMAGE",
    "SANDBOX_IMAGE",
    "SUPERVISOR_IMAGE",
    "SOURCE_REVISION",
    "HELM_CHART",
    "WORKSPACE_HELM_CHART",
  ]) {
    assert.equal(
      process.env[`OCC_DEVELOPMENT_OPENSHELL_${name}`],
      undefined,
      "this fixture qualifies stock OpenShell",
    );
  }
  const cleanup = [];
  const stackCleanup = [];
  const measurement = (event, data) => {
    const value = { kind: openShellGitRetentionKind, event, ...data };
    assert.ok(
      projectOpenShellGitRetention(value),
      "qualification receipt must have a safe CI projection",
    );
    t.diagnostic(`openclaw-ci-measurement ${JSON.stringify(value)}`);
  };
  // Stop workloads before the issuer, and run every cleanup even after a failure.
  t.after(async () => {
    tearingDown = true;
    const errors = [];
    for (const operation of [...stackCleanup].reverse().concat([...cleanup].reverse())) {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "Installed Git fixture cleanup failed");
    }
    measurement("cleanup", { outcome: "passed" });
  });
  const stack = await localFirstAgentStack(
    {
      diagnostic: (message) => t.diagnostic(message),
      after: (operation) => stackCleanup.push(operation),
    },
    { modelCredential: "openai" },
  );
  const state = JSON.parse(await readFile(join(stack.directory, "state.json"), "utf8"));
  assert.equal(state.deploymentMode, "k3d");
  assert.equal(state.sandboxDriver, "openshell");
  assert.equal(state.containerEngine, "docker");
  assert.match(state.cluster, /^occ-dev-first-agent-[a-f0-9]{12}$/);
  assert.match(state.dockerHost, /^unix:\/\//);
  const directory = await mkdtemp(join(tmpdir(), "oce-installed-git-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  // The CI reporter retains only the closed identity/digest/counter projection
  // after this private file is removed, including on passing runs.
  const checkpoint = async (event, data) => {
    const record = JSON.stringify({ event, ...data });
    assert.ok(record.length <= 16_384, "qualification metadata must remain bounded");
    await appendFile(join(directory, "observations.jsonl"), `${record}\n`, { mode: 0o600 });
    measurement(event, data);
  };
  // Infrastructure processes cannot inherit either model credential or ambient
  // GitHub credentials. Only the API Secret request below carries the model key.
  const environment = Object.fromEntries(
    ["PATH", "HOME", "DOCKER_CONFIG", "XDG_CONFIG_HOME", "TMPDIR"]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
  environment.DOCKER_HOST = state.dockerHost;
  const command = async (executable, args, options = {}) =>
    (
      await run(executable, args, {
        cwd: root,
        env: environment,
        timeout: 30_000,
        signal: tearingDown ? undefined : t.signal,
        ...options,
      })
    ).stdout;
  const kubectl = [
    "--kubeconfig",
    join(stack.directory, "kubeconfig"),
    "--context",
    `k3d-${state.cluster}`,
  ];
  const kube = (args, options) => command("kubectl", [...kubectl, ...args], options);
  const platform = state.platformNamespace;
  const apply = (objects) =>
    kube(["apply", "-f", "-"], {
      input: JSON.stringify({ apiVersion: "v1", kind: "List", items: objects }),
    });
  const helmContext = [
    "--kubeconfig",
    join(stack.directory, "kubeconfig"),
    "--kube-context",
    `k3d-${state.cluster}`,
    "--namespace",
    platform,
  ];
  const admin = JSON.parse(
    await readFile(join(stack.directory, "initial-admin-service-key.json"), "utf8"),
  );
  const request = createOpenShellGitApi({
    origin: stack.environment.OCC_URL,
    key: admin.data.key,
    signal: t.signal,
    after: (operation) => cleanup.push(operation),
  });
  const namespaces = await request("GET", "/namespaces");
  const defaults = namespaces.filter(({ name }) => name === "default");
  assert.equal(defaults.length, 1);
  const namespace = await request("GET", `/namespaces/${defaults[0].id}`);
  assert.equal(namespace.status, "ready");
  const namespaceList = JSON.parse(
    await kube(["get", "namespaces", "-l", "openclaw.dev/namespace", "-o", "json"]),
  );
  assert.equal(namespaceList.items.length, 1);
  const sandboxNamespace = namespaceList.items[0].metadata.name;
  assert.equal(namespaceList.items[0].metadata.labels["openshell.ai/openclaw-workspace"], "true");
  const secret = await request("POST", `/namespaces/${namespace.id}/secrets`, {
    name: "installed-git-model",
    value: process.env.OPENAI_API_KEY,
  });
  const registeredModel = await request("POST", `/namespaces/${namespace.id}/credential-sources`, {
    name: "installed-git-model",
    type: "openai",
    config: { authorized_base_url: "https://api.openai.com/v1" },
    secrets: { api_key: secret.ref },
  });
  const modelSource = await eventually("Gateway-owned model source", async () => {
    const current = await request(
      "GET",
      `/namespaces/${namespace.id}/credential-sources/${registeredModel.id}`,
    );
    assert.equal(current.ownerCapability, "credential_gateway");
    assert.equal(current.egress, undefined);
    assert.notEqual(current.status?.state, "failed", "model source registration failed");
    return current.state === "ready" && current.status?.state === "ready" ? current : undefined;
  });

  const network = JSON.parse(
    await command("docker", ["network", "inspect", `k3d-${state.cluster}`]),
  );
  const bridge = network[0].IPAM.Config[0].Gateway;
  assert.match(bridge, /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)[\d.]+$/);
  const originHost = `git-fixture.${platform}.svc.cluster.local`;
  const authorityHost = `openclaw-enterprise-openshell-git.${platform}.svc.cluster.local`;
  const tls = await certificates(command, directory, originHost, authorityHost);
  const origin = await startSkipperPrivateGitOrigin({
    host: bridge,
    advertisedHost: originHost,
    tls: { ...tls.origin, ca: tls.ca },
  });
  cleanup.push(() => origin.close());
  const originPort = Number(new URL(origin.origin).port);
  const metadata = (name) => ({ name, namespace: platform });
  await apply([
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: metadata("git-fixture"),
      spec: { ports: [{ name: "https", port: 443, targetPort: originPort }] },
    },
    {
      apiVersion: "v1",
      kind: "Endpoints",
      metadata: metadata("git-fixture"),
      subsets: [
        {
          addresses: [{ ip: bridge }],
          ports: [{ name: "https", port: originPort, protocol: "TCP" }],
        },
      ],
    },
  ]);
  const service = JSON.parse(
    await kube(["get", "service", "git-fixture", "-n", platform, "-o", "json"]),
  );
  const dns = JSON.parse(
    await kube(["get", "configmap", "coredns", "-n", "kube-system", "-o", "json"]),
  );
  // Only GitHub's two exact names are redirected. Real model traffic continues
  // through the ordinary authenticated provider and public DNS.
  dns.data.Corefile += `\ngithub.com:53 api.github.com:53 {\n  errors\n  hosts {\n    ${service.spec.clusterIP} github.com api.github.com\n    fallthrough\n  }\n}\n`;
  await apply([dns]);
  await kube(["rollout", "restart", "deployment/coredns", "-n", "kube-system"]);
  await kube(["rollout", "status", "deployment/coredns", "-n", "kube-system", "--timeout=120s"], {
    timeout: 130_000,
  });

  const gatewayValues = JSON.parse(
    await command("helm", ["get", "values", "openshell-gateway", ...helmContext, "-o", "json"]),
  );
  assert.equal(gatewayValues.server.disableTls, false);
  assert.equal(gatewayValues.server.auth.allowUnauthenticatedUsers, false);
  assert.equal(gatewayValues.server.tls.enableMtls, true);
  const jwtSecret =
    gatewayValues.server.sandboxJwt?.existingSecretName || "openshell-gateway-jwt-keys";
  const publicKey = Buffer.from(
    (
      await kube([
        "get",
        "secret",
        jwtSecret,
        "-n",
        platform,
        "-o",
        "jsonpath={.data.public\\.pem}",
      ])
    ).trim(),
    "base64",
  ).toString();
  const keyId = Buffer.from(
    (await kube(["get", "secret", jwtSecret, "-n", platform, "-o", "jsonpath={.data.kid}"])).trim(),
    "base64",
  )
    .toString()
    .trim();
  assert.ok(publicKey.includes("BEGIN PUBLIC KEY") && keyId);
  const registry = {
    version: 1,
    backendId: "repository-backend",
    providerInstanceId: "isolated-git-fixture",
    appId: origin.appId,
    githubInstallationId: origin.installationId,
    maximumDurationSeconds: 600,
    repositories: [
      {
        repositoryRef: origin.repositoryRef,
        repositoryId: origin.repositoryId,
        repository: origin.repository,
        namespaces: [
          {
            namespaceId: namespace.id,
            profiles: ["github-repository"],
            permissions: { metadata: "read", contents: "write" },
          },
        ],
      },
    ],
  };
  const configMap = (name, data) => ({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: metadata(name),
    immutable: true,
    data,
  });
  const privateSecret = (name, stringData) => ({
    apiVersion: "v1",
    kind: "Secret",
    metadata: metadata(name),
    type: "Opaque",
    stringData,
  });
  await apply([
    configMap("git-fixture-registry-v1", { "registry.json": JSON.stringify(registry) }),
    configMap("git-fixture-ca", { "ca.crt": tls.ca }),
    configMap("git-gateway-public-key", { "gateway-public.pem": publicKey }),
    privateSecret("git-fixture-app", {
      "private-key.pem": origin.privateKey.export({ type: "pkcs8", format: "pem" }),
    }),
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: metadata("git-fixture-custody"),
      type: "Opaque",
      data: { "custody.key": randomBytes(32).toString("base64") },
    },
    privateSecret("git-authority-tls", {
      "tls.crt": tls.authority.cert,
      "tls.key": tls.authority.key,
    }),
  ]);
  const gatewayLabels = {
    "app.kubernetes.io/name": "openshell",
    "app.kubernetes.io/instance": "openshell-gateway",
  };
  const authorityRule = {
    to: [peer(platform, workerLabels)],
    ports: [{ protocol: "TCP", port: 8445 }],
  };
  const policy = (name, labels, egress) => ({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name },
    spec: { podSelector: { matchLabels: labels }, policyTypes: ["Egress"], egress },
  });
  const supervisorPolicy = policy("allow-installed-git-fixture", supervisorLabels, [
    authorityRule,
    { to: [{ ipBlock: { cidr: `${bridge}/32` } }], ports: [{ protocol: "TCP", port: originPort }] },
  ]);
  await apply([
    {
      ...supervisorPolicy,
      metadata: { ...supervisorPolicy.metadata, namespace: sandboxNamespace },
    },
  ]);
  const installation = loadYaml(await readFile(join(stack.directory, "installation.yaml"), "utf8"));
  const sandbox = installation.drivers.sandbox;
  const backend = installation.backend.find(({ type }) => type === "openshell");
  assert.equal(backend.drivers.sandbox, sandbox.id);
  assert.ok(installation.drivers.credential_gateway && backend.drivers.credential_gateway);
  backend.drivers.credential_proxy = sandbox.id;
  installation.drivers.credential_proxy = { id: sandbox.id, configuration: {} };
  sandbox.configuration.gateway.networkPolicyResources.push(supervisorPolicy);
  // The protected sender owns GitHub TLS inspection. Remove only Local Setup's
  // exact uninspected Git rule; preserve every unrelated operator policy.
  const networkPolicies = sandbox.configuration.policy.networkPolicies;
  const sourceControl = networkPolicies.filter(({ name }) => name === "source-control");
  assert.deepEqual(sourceControl, [
    {
      name: "source-control",
      endpoints: [{ host: "github.com", ports: [443], tls: "skip" }],
      binaries: [{ path: "/usr/bin/git" }],
    },
  ]);
  sandbox.configuration.policy.networkPolicies = networkPolicies.filter(
    (rule) => rule !== sourceControl[0],
  );
  installation.backend.push({
    id: "repository-backend",
    type: "github",
    configuration: { registryPath: "/etc/openclaw/repository-registry/registry.json" },
    drivers: { repo: "repository-credentials" },
  });
  installation.repository = {
    id: "repository-credentials",
    configuration: { sessionDurationSeconds: 600 },
    openShell: {
      registrationName: "oce-prepared-git",
      authority: {
        host: "0.0.0.0",
        port: 8445,
        certificatePath: "/etc/openclaw/openshell-git/tls.crt",
        privateKeyPath: "/etc/openclaw/openshell-git/tls.key",
        issuerPublicKeyPath: "/etc/openclaw/openshell-git/gateway-public.pem",
        issuer: `openshell-gateway:${gatewayValues.gatewayConfig?.["openshell.gateway.gateway_jwt"]?.gateway_id || "openshell-gateway"}`,
        audience: "oce-prepared-git",
        keyId,
      },
    },
    preparedGitHub: {
      custodyKeyPath: "/etc/openclaw/prepared-repository/custody.key",
      privateKeyPath: "/etc/openclaw/prepared-repository/private-key.pem",
      apiOrigin: "https://api.github.com",
      issuerCaPath: "/etc/openclaw/prepared-repository-ca/ca.crt",
    },
  };
  const installationJSON = JSON.stringify(installation);
  await apply([
    privateSecret("occ-installation-startup", { "installation.yaml": installationJSON }),
  ]);
  const values = JSON.parse(await readFile(join(stack.directory, "helm-values.json"), "utf8"));
  values.controlPlane = { ...values.controlPlane, installationChecksum: hash(installationJSON) };
  values.repositoryCredentials = {
    ...values.repositoryCredentials,
    enabled: false,
    authority: "prepared-git",
    backendId: "repository-backend",
    registryConfigMapName: "git-fixture-registry-v1",
    registryKey: "registry.json",
    appKeySecretName: "git-fixture-app",
    appKeyKey: "private-key.pem",
    preparedCustodySecretName: "git-fixture-custody",
    preparedProviderCaConfigMapName: "git-fixture-ca",
    upstreamCidrs: [`${bridge}/32`],
    upstreamPort: originPort,
  };
  values.openshellGit = {
    enabled: true,
    mode: "protected",
    port: 8445,
    tlsSecretName: "git-authority-tls",
    issuerPublicKeyConfigMapName: "git-gateway-public-key",
    clients: [peer(platform, gatewayLabels), peer(sandboxNamespace, supervisorLabels)],
  };
  const valuesFile = join(directory, "oce-values.json");
  await writeFile(valuesFile, JSON.stringify(values), { mode: 0o600 });
  await command(
    "helm",
    [
      "upgrade",
      "openclaw-enterprise",
      join(root, "deploy/helm/openclaw-enterprise"),
      ...helmContext,
      "-f",
      valuesFile,
      "--wait",
      "--timeout",
      "180s",
    ],
    { timeout: 190_000 },
  );

  const supervisor = await trustedSupervisor({
    command,
    cleanup,
    directory,
    cluster: state.cluster,
    ca: tls.ca,
    checkpoint,
  });
  gatewayValues.supervisor.image = supervisor.image;
  gatewayValues.gatewayConfig["openshell.supervisor.middleware"] = [
    {
      name: "oce-prepared-git",
      grpc_endpoint: `https://${authorityHost}:8445`,
      tls_ca_cert_path: "/etc/openshell-git-ca/ca.crt",
      audience: "oce-prepared-git",
      binding_policy: "allowlist",
      bindings: ["http_request_pre_credentials"],
      max_payload_bytes: 4194304,
      timeout: "5s",
    },
  ];
  gatewayValues.server.extraVolumes = [
    ...(gatewayValues.server.extraVolumes ?? []),
    { name: "git-authority-ca", configMap: { name: "git-fixture-ca" } },
  ];
  gatewayValues.server.extraVolumeMounts = [
    ...(gatewayValues.server.extraVolumeMounts ?? []),
    { name: "git-authority-ca", mountPath: "/etc/openshell-git-ca", readOnly: true },
  ];
  const gatewayFile = join(directory, "gateway-values.json");
  await writeFile(gatewayFile, JSON.stringify(gatewayValues), { mode: 0o600 });
  const charts = (await readdir(join(stack.directory, "openshell/chart"))).filter((name) =>
    /^helm-chart-0\.1\.6\.tgz$/.test(name),
  );
  assert.equal(charts.length, 1);
  await command(
    "helm",
    [
      "upgrade",
      "openshell-gateway",
      join(stack.directory, "openshell/chart", charts[0]),
      ...helmContext,
      "-f",
      gatewayFile,
      "--wait",
      "--timeout",
      "180s",
    ],
    { timeout: 190_000 },
  );

  const port = await availablePort();
  const forward = spawn(
    "kubectl",
    [
      ...kubectl,
      "-n",
      platform,
      "port-forward",
      "--address=127.0.0.1",
      "service/openshell-gateway",
      `${port}:8080`,
    ],
    { env: environment, stdio: "ignore" },
  );
  let forwardFailed = false;
  forward.on("error", () => {
    forwardFailed = true;
  });
  cleanup.push(() => stopProcess(forward));
  const gatewayBackend = await localOpenShellGatewayOptions(
    { after: (operation) => cleanup.push(operation) },
    kubectl,
    environment,
    platform,
    port,
  );
  const gatewayClient = new GrpcOpenShellGatewayClient(gatewayBackend);
  cleanup.push(() => gatewayClient.close());
  await eventually("authenticated OpenShell workspace", async () => {
    assert.equal(forwardFailed, false, "Gateway port-forward could not start");
    assert.equal(forward.exitCode, null, "Gateway port-forward exited");
    try {
      return await gatewayClient.getWorkspace(sandboxNamespace, AbortSignal.timeout(5000));
    } catch {
      return undefined;
    }
  });
  const verifySupervisorImage = async ({ sandboxName, sandboxId }) => {
    const selected = await gatewayClient.getSandbox(
      { workspace: sandboxNamespace, name: sandboxName },
      t.signal,
    );
    assert.equal(selected?.id, sandboxId, "the selected Sandbox must retain its identity");
    const resource = JSON.parse(
      await kube([
        "get",
        "sandboxes.agents.x-k8s.io",
        sandboxName,
        "-n",
        sandboxNamespace,
        "-o",
        "json",
      ]),
    );
    assert.equal(resource.metadata.labels?.["openshell.ai/sandbox-id"], sandboxId);
    const pods = JSON.parse(
      await kube(["get", "pods", "-n", sandboxNamespace, "-o", "json"]),
    ).items;
    const workloads = pods.filter(
      (pod) =>
        pod.metadata.labels?.["openshell.ai/boundary-role"] === "workload" &&
        pod.metadata.ownerReferences?.some(
          (owner) => owner.kind === "Sandbox" && owner.uid === resource.metadata.uid,
        ),
    );
    assert.equal(workloads.length, 1, "the selected Sandbox must have exactly one workload Pod");
    const workload = workloads[0];
    assert.equal(workload.metadata.annotations?.["openshell.ai/sandbox-id"], sandboxId);
    const boundaryPair = workload.metadata.labels?.["openshell.ai/boundary-pair"];
    assert.ok(boundaryPair, "the workload must identify its supervisor boundary pair");
    const supervisors = pods.filter(
      (pod) =>
        pod.metadata.labels?.["openshell.ai/boundary-role"] === "supervisor" &&
        pod.metadata.labels?.["openshell.ai/boundary-pair"] === boundaryPair,
    );
    assert.equal(
      supervisors.length,
      1,
      "the workload must have exactly one matching supervisor Pod",
    );
    const pod = supervisors[0];
    assert.equal(pod.metadata.annotations?.["openshell.ai/sandbox-id"], sandboxId);
    assert.ok(
      pod.metadata.ownerReferences?.some(
        (owner) => owner.kind === "Sandbox" && owner.uid === resource.metadata.uid,
      ),
      "the supervisor must belong to the selected Sandbox resource",
    );
    const container = pod.spec.containers.find(({ name }) => name === "supervisor");
    const status = pod.status.containerStatuses?.find(({ name }) => name === "supervisor");
    assert.ok(
      container && status?.ready && status.state.running,
      "the supervisor must be running and ready",
    );
    assert.equal(
      container.image,
      supervisor.reference,
      "the supervisor must select the imported trust-only image",
    );
    // CRI implementations report either the manifest or image-config digest.
    // Both were observed from this build, never inferred from the requested tag.
    const runningDigest = status.imageID.match(/sha256:[a-f0-9]{64}$/)?.[0];
    assert.ok(
      [supervisor.image.digest, supervisor.configDigest].includes(runningDigest),
      "the running supervisor image must match the imported trust-only build",
    );
    return {
      sandboxId,
      workloadPodUid: workload.metadata.uid,
      supervisorPodName: pod.metadata.name,
      supervisorPodUid: pod.metadata.uid,
      image: container.image,
      imageId: status.imageID,
      containerId: status.containerID,
      binaryHash: supervisor.binaryHash,
    };
  };
  const worker = async () => {
    const pods = JSON.parse(
      await kube(["get", "pods", "-n", platform, "-l", selector(workerLabels), "-o", "json"]),
    );
    return pods.items.find(
      (pod) =>
        !pod.metadata.deletionTimestamp &&
        pod.status.conditions?.some(({ type, status }) => type === "Ready" && status === "True"),
    );
  };
  const durableIdentity = async () => {
    const pods = JSON.parse(
      await kube(["get", "pods", "-n", platform, "-l", "app=postgres", "-o", "json"]),
    );
    const postgres = pods.items;
    assert.equal(postgres.length, 1);
    const custody = JSON.parse(
      await kube([
        "get",
        "secret",
        "git-fixture-custody",
        "-n",
        platform,
        "-o",
        "jsonpath={.metadata}",
      ]),
    );
    return {
      databaseUid: postgres[0].metadata.uid,
      custodyUid: custody.uid,
      custodyVersion: custody.resourceVersion,
    };
  };
  const workerEvents = async (pod, diagnostics) => {
    if (diagnostics) {
      diagnostics.logReads++;
    }
    let logs;
    try {
      logs = await kube(["logs", pod.metadata.name, "-n", platform, "-c", "worker", "--tail=2000"]);
    } catch (error) {
      if (diagnostics) {
        diagnostics.logReadFailures++;
      }
      throw error;
    }
    if (diagnostics) {
      diagnostics.logReadSuccesses++;
    }
    const lines = logs.split("\n").filter((line) => line.length > 0);
    if (diagnostics) {
      diagnostics.linesRead += lines.length;
      if (lines.length >= 2000) {
        diagnostics.tailLimitReads++;
      }
    }
    const events = [];
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event !== null && typeof event === "object") {
          events.push(event);
          if (diagnostics) {
            diagnostics.parsedEvents++;
          }
        }
      } catch {
        // Container startup can write non-JSON lines; only structured events qualify.
        if (diagnostics) {
          diagnostics.parseFailures++;
        }
      }
    }
    return events;
  };
  const completedWork = async (pod, { agentId, revisionId }, accepts, observed) => {
    const events = observed ?? (await workerEvents(pod));
    for (const event of events) {
      if (
        event.event === "worker.completed" &&
        event.agentId === agentId &&
        event.revisionId === revisionId &&
        accepts(event)
      ) {
        assert.notEqual(event.outcome, "permanent", "revision maintenance failed permanently");
        if (event.outcome === "success") {
          return { workId: event.workId, code: event.code, workerUid: pod.metadata.uid };
        }
      }
    }
    return undefined;
  };
  // The scenario waits for the public deadline before starting this bounded
  // observation. No clock override or explicit withdrawal drives expiry.
  const waitForExpiry = async (identity) => {
    const diagnostics = {
      namespaceId: namespace.id,
      agentId: identity.agentId,
      revisionId: identity.revisionId,
      repositoryRef: origin.repositoryRef,
      lastWorkerUid: null,
      polls: 0,
      workerReadFailures: 0,
      noReadyWorkerPolls: 0,
      logReads: 0,
      logReadSuccesses: 0,
      logReadFailures: 0,
      linesRead: 0,
      parsedEvents: 0,
      parseFailures: 0,
      tailLimitReads: 0,
      workerChanges: 0,
      matchingEventReads: 0,
      rejectedEventReads: 0,
      driverSuccessSeen: false,
      workerAcknowledgementSeen: false,
      observationsTruncated: false,
      observations: [],
    };
    try {
      return await eventually("observed repository expiry", async () => {
        diagnostics.polls++;
        let pod;
        try {
          pod = await worker();
        } catch (error) {
          diagnostics.workerReadFailures++;
          throw error;
        }
        if (!pod) {
          diagnostics.noReadyWorkerPolls++;
          return undefined;
        }
        if (diagnostics.lastWorkerUid && diagnostics.lastWorkerUid !== pod.metadata.uid) {
          diagnostics.workerChanges++;
        }
        diagnostics.lastWorkerUid = pod.metadata.uid;
        const events = await workerEvents(pod, diagnostics);
        for (const event of events) {
          if (
            event.agentId !== identity.agentId ||
            event.revisionId !== identity.revisionId ||
            ![
              "worker.openshell-git-expiry",
              "worker.completed",
              "worker.repository-cleanup-warning",
            ].includes(event.event)
          ) {
            continue;
          }
          diagnostics.matchingEventReads++;
          // Keep scope mismatches visible without publishing another scope's ID.
          // Project before buffering: neither unknown enums nor extra log fields
          // may enter the diagnostic, including when the file later fails.
          let repository = "mismatch";
          if (event.repositoryRef === undefined) {
            repository = "absent";
          } else if (event.repositoryRef === origin.repositoryRef) {
            repository = "match";
          }
          const observation = projectOpenShellGitExpiryObservation({
            event: event.event,
            outcome: event.outcome,
            check: event.check,
            failure: event.failure,
            code: event.code,
            cause: event.cause,
            workerUid: pod.metadata.uid,
            namespaceMatches: event.namespaceId === namespace.id,
            repository,
          });
          if (!observation) {
            diagnostics.rejectedEventReads++;
            continue;
          }
          if (
            observation.event === "worker.openshell-git-expiry" &&
            observation.namespaceMatches &&
            observation.repository === "match" &&
            observation.outcome === "withdrawn" &&
            observation.check === "record-reduced-generation"
          ) {
            diagnostics.driverSuccessSeen = true;
          }
          if (
            observation.event === "worker.completed" &&
            observation.namespaceMatches &&
            observation.outcome === "success" &&
            observation.code === "REPOSITORY_ACCESS_WITHDRAWN"
          ) {
            diagnostics.workerAcknowledgementSeen = true;
          }
          const duplicate = diagnostics.observations.findIndex(
            (previous) => JSON.stringify(previous) === JSON.stringify(observation),
          );
          if (duplicate !== -1) {
            diagnostics.observations.splice(duplicate, 1);
          }
          diagnostics.observations.push(observation);
          if (diagnostics.observations.length > 16) {
            diagnostics.observations.shift();
            diagnostics.observationsTruncated = true;
          }
        }
        // This bundled Driver event follows the retained-provider profile read and
        // recording of the reduced generation. A generic cleanup acknowledgement
        // alone cannot establish that expiry exercised this path rather than v2.
        const expiry = events.find(
          (event) =>
            event.event === "worker.openshell-git-expiry" &&
            event.namespaceId === namespace.id &&
            event.agentId === identity.agentId &&
            event.revisionId === identity.revisionId &&
            event.repositoryRef === origin.repositoryRef &&
            event.outcome === "withdrawn" &&
            event.check === "record-reduced-generation",
        );
        if (!expiry) {
          return undefined;
        }
        const completion = await completedWork(
          pod,
          identity,
          (event) => event.code === "REPOSITORY_ACCESS_WITHDRAWN",
          events,
        );
        return (
          completion && {
            ...completion,
            expiry: {
              event: expiry.event,
              namespaceId: expiry.namespaceId,
              agentId: expiry.agentId,
              revisionId: expiry.revisionId,
              repositoryRef: expiry.repositoryRef,
              outcome: expiry.outcome,
              check: expiry.check,
            },
          }
        );
      });
    } catch (error) {
      try {
        measurement("git-expiry-unconfirmed", diagnostics);
      } catch {
        // Diagnostic failures must not hide the original timeout/read failure.
      }
      throw error;
    }
  };
  const restartWorker = async (identity) => {
    const before = await eventually("ready worker", worker);
    const durable = await durableIdentity();
    await kube(["rollout", "restart", "deployment/openclaw-enterprise-worker", "-n", platform]);
    await kube(
      [
        "rollout",
        "status",
        "deployment/openclaw-enterprise-worker",
        "-n",
        platform,
        "--timeout=180s",
      ],
      { timeout: 190_000 },
    );
    const after = await eventually("replacement worker", async () => {
      const pod = await worker();
      return pod?.metadata.uid !== before.metadata.uid ? pod : undefined;
    });
    await eventually("replacement worker revision maintenance", () =>
      completedWork(after, identity, (event) =>
        event.workId?.startsWith(`agent_revision:${identity.revisionId}:maintenance:`),
      ),
    );
    assert.deepEqual(
      await durableIdentity(),
      durable,
      "worker restart must retain PostgreSQL and custody",
    );
    return { beforeUid: before.metadata.uid, afterUid: after.metadata.uid, ...durable };
  };
  return {
    request,
    namespace,
    modelSource,
    repositoryRef: origin.repositoryRef,
    origin,
    kube,
    gatewayBackend,
    gatewayClient,
    workspace: sandboxNamespace,
    sandboxNamespace,
    waitForExpiry,
    verifySupervisorImage,
    restartWorker,
    checkpoint,
  };
}

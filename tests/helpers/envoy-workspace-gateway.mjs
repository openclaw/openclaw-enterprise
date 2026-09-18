import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { connect as connectTls } from "node:tls";
import { promisify } from "node:util";

const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const { GatewayClient } = await import(
  pathToFileURL(controllerRequire.resolve("@openclaw/gateway-client")).href
);

const executeFile = promisify(execFile);
const gatewayHostname = "localhost";
const gatewayReleaseName = "oce-workspace-files";
const gatewayName = `${gatewayReleaseName}-agent-gateways`;
const gatewayServiceKeyName = "occ";
const gatewayServiceKeyHeader = "x-api-key";
const gatewayIdentity = "occ-workspace-files";
const gatewayIdentityHeader = "x-occ-identity";
const envoyNamespace = process.env.OCC_TEST_ENVOY_GATEWAY_NAMESPACE ?? "envoy-gateway-system";
const certManagerNamespace = process.env.OCC_TEST_CERT_MANAGER_NAMESPACE ?? "cert-manager";
const caSecretName = "oce-workspace-files-ca";
const caIssuerName = "oce-workspace-files-ca";
const tlsSecretName = `${gatewayName}-tls`;
const tcpForwarderPort = 10443;
const helmBin = process.env.OCC_HELM_BIN ?? "helm";
const helmEnvironment = {
  ...process.env,
  HELM_CACHE_HOME: process.env.HELM_CACHE_HOME ?? "/tmp/oce-helm-cache",
  HELM_CONFIG_HOME: process.env.HELM_CONFIG_HOME ?? "/tmp/oce-helm-config",
  HELM_DATA_HOME: process.env.HELM_DATA_HOME ?? "/tmp/oce-helm-data",
};

function nonempty(value, name) {
  assert.equal(typeof value, "string", `${name} must be configured.`);
  assert.ok(value.trim().length > 0, `${name} must be nonempty.`);
  return value;
}

export function resolveGatewayPublisherImage(topology) {
  const image = nonempty(
    topology.gatewayPublisherImage,
    "Docker-local gateway publisher image; set OCC_TEST_KUBERNETES_GATEWAY_DOCKER_IMAGE",
  );
  assert.match(
    image,
    /^sha256:[a-f0-9]{64}$/i,
    "Docker-local gateway publisher image must be an immutable Docker image ID.",
  );
  return image;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

async function command(
  file,
  args,
  { env = process.env, timeoutMs = 120_000, redactions = [] } = {},
) {
  try {
    return await executeFile(file, args, { env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    throw new Error(
      redact(
        `${file} ${args.join(" ")} failed with exit ${error.code ?? "unknown"}.\n${String(
          error.stdout ?? "",
        )}${String(error.stderr ?? "")}`,
        redactions,
      ),
    );
  }
}

function redact(value, redactions) {
  return redactions
    .filter((secret) => typeof secret === "string" && secret.length > 0)
    .reduce((current, secret) => current.split(secret).join("<redacted>"), value);
}

async function renderGatewayRoutingManifests({
  releaseNamespace,
  apiKeySecretName,
  gatewayClassName,
}) {
  const { stdout } = await command(
    helmBin,
    [
      "template",
      gatewayReleaseName,
      "deploy/helm/openclaw-enterprise",
      "--namespace",
      releaseNamespace,
      "--values",
      "deploy/examples/production/values.yaml",
      "--show-only",
      "templates/gateway-routing.yaml",
      "--set",
      "gatewayRouting.enabled=true",
      "--set",
      `gatewayRouting.hostname=${gatewayHostname}`,
      "--set",
      `gatewayRouting.gatewayClassName=${gatewayClassName}`,
      "--set",
      `gatewayRouting.envoyNamespace=${envoyNamespace}`,
      "--set",
      `gatewayRouting.apiKeySecretName=${apiKeySecretName}`,
      "--set",
      `gatewayRouting.issuerRef.name=${caIssuerName}`,
      "--set",
      "gatewayRouting.issuerRef.kind=Issuer",
      "--set",
      "gatewayRouting.issuerRef.group=cert-manager.io",
    ],
    { env: helmEnvironment },
  );
  return stdout;
}

function yamlScalar(value) {
  return JSON.stringify(value);
}

export async function ensureEnvoyGatewayControllers({ kubectl, waitFor }) {
  await kubectl("get", "crd", "gateways.gateway.networking.k8s.io");
  await kubectl("get", "crd", "securitypolicies.gateway.envoyproxy.io");
  await kubectl("get", "crd", "certificates.cert-manager.io");
  await waitFor("cert-manager controller readiness", async () => {
    const deployments = JSON.parse(
      await kubectl("get", "deployments", "--namespace", certManagerNamespace, "-o", "json"),
    ).items;
    const availableNames = new Set(
      deployments
        .filter((deployment) =>
          deployment.status?.conditions?.some(
            ({ type, status }) => type === "Available" && status === "True",
          ),
        )
        .map((deployment) => deployment.metadata?.labels?.["app.kubernetes.io/name"]),
    );
    return ["cert-manager", "cainjector", "webhook"].every((name) => availableNames.has(name))
      ? true
      : undefined;
  });
  await waitFor("Envoy Gateway controller readiness", async () => {
    const deployments = JSON.parse(
      await kubectl("get", "deployments", "--namespace", envoyNamespace, "-o", "json"),
    ).items;
    return deployments.some(
      (deployment) =>
        deployment.metadata?.labels?.["app.kubernetes.io/name"] === "gateway-helm" &&
        deployment.status?.conditions?.some(
          ({ type, status }) => type === "Available" && status === "True",
        ),
    )
      ? true
      : undefined;
  });
}

export async function createEnvoyWorkspaceGatewayPlan(context, { platformNamespace }, helpers) {
  let apiKey = randomBytes(32).toString("base64url");
  const directory = await mkdtemp(join(tmpdir(), "occ-envoy-workspace-files-"));
  const apiKeyPath = join(directory, "gateway-api-key");
  const apiKeySecretName = `oce-gateway-api-key-${hash(platformNamespace)}`;
  await chmod(directory, 0o700);
  await writeFile(apiKeyPath, apiKey, { mode: 0o600 });
  context.after(async () => rm(directory, { recursive: true, force: true }));

  await applyGatewayApiKeySecret(helpers, platformNamespace, apiKeySecretName, apiKey);
  await ensureCertificateAuthority(platformNamespace, helpers);
  const gatewayClassName = `oce-workspace-files-${hash(platformNamespace)}`;
  await ensureGatewayClass(helpers, gatewayClassName);
  context.after(async () => {
    await helpers
      .kubectl("delete", "gatewayclass", gatewayClassName, "--ignore-not-found=true")
      .catch(() => undefined);
  });
  const gatewayRoutingManifests = await renderGatewayRoutingManifests({
    releaseNamespace: platformNamespace,
    apiKeySecretName,
    gatewayClassName,
  });
  registerRenderedExternalCleanup(context, gatewayRoutingManifests, platformNamespace, helpers);
  await helpers.applyManifest(gatewayRoutingManifests);
  await waitForGatewayCertificate(platformNamespace, helpers);
  await waitForGatewayProgrammed(platformNamespace, helpers);

  return {
    get apiKey() {
      return apiKey;
    },
    apiKeyPath,
    apiKeySecretName,
    routing: {
      hostname: gatewayHostname,
      gatewayName,
      gatewayNamespace: platformNamespace,
      envoyNamespace,
    },
    nativeOptions: {
      gatewayAuth: {
        auth: {
          mode: "trusted-proxy",
          identityScopes: { [gatewayIdentity]: ["operator.admin"] },
          trustedProxy: { userHeader: gatewayIdentityHeader, allowUsers: [gatewayIdentity] },
        },
        allowRealIpFallback: true,
        trustedProxies: await clusterPodCidrs(helpers),
      },
    },
    async connect(topology) {
      await waitForComputeGatewayRoute(topology, helpers);
      const envoyService = await waitForEnvoyService(platformNamespace, helpers);
      await startInClusterTcpForwarder(context, topology, helpers, envoyService);
      await waitForGatewayProgrammed(platformNamespace, helpers);
      const gatewayUrl = `wss://${gatewayHostname}/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}`;
      return {
        url: gatewayUrl,
        async assertSecurity() {
          await assertGatewayAuthenticationDenials({
            url: `wss://${gatewayHostname}/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}`,
            validApiKey: apiKey,
          });
          await assertDirectGatewayPeerDenied(context, topology, helpers, envoyService);
        },
        async renewCertificate() {
          const previous = await gatewayServedCertificate(gatewayUrl);
          await helpers.kubectl(
            "delete",
            "secret",
            tlsSecretName,
            "--namespace",
            platformNamespace,
            "--ignore-not-found=true",
          );
          await helpers.waitFor(
            "cert-manager to write a renewed workspace Gateway leaf certificate",
            async () => {
              try {
                const candidate = await gatewayLeafCertificate(platformNamespace, helpers);
                return candidate.serialNumber !== previous.serialNumber ? candidate : undefined;
              } catch (error) {
                if (/NotFound|not found/i.test(error.stderr ?? error.message)) {
                  return undefined;
                }
                throw error;
              }
            },
          );
          const next = await helpers.waitFor(
            "Envoy data plane to serve the renewed workspace Gateway leaf certificate",
            async () => {
              const candidate = await gatewayServedCertificate(gatewayUrl).catch(() => undefined);
              return candidate?.serialNumber !== undefined &&
                candidate.serialNumber !== previous.serialNumber
                ? candidate
                : undefined;
            },
          );
          assert.equal(
            next.issuer,
            previous.issuer,
            "renewed workspace Gateway certificate must keep the same configured CA issuer",
          );
          return { previous, next };
        },
        async rotateApiKey(verifyOcc) {
          const oldApiKey = apiKey;
          const newApiKey = randomBytes(32).toString("base64url");
          await applyGatewayApiKeySecret(helpers, platformNamespace, apiKeySecretName, [
            oldApiKey,
            newApiKey,
          ]);
          await helpers.waitFor("Envoy Gateway to accept the staged new API key", async () =>
            assertGatewayApiKeyAccepted({ url: gatewayUrl, apiKey: newApiKey })
              .then(() => true)
              .catch(() => undefined),
          );
          await assertGatewayApiKeyAccepted({ url: gatewayUrl, apiKey: oldApiKey });
          // Switch the mounted entry while retaining the old credential during propagation.
          await applyGatewayApiKeySecret(helpers, platformNamespace, apiKeySecretName, [
            newApiKey,
            oldApiKey,
          ]);
          apiKey = newApiKey;
          await writeFile(apiKeyPath, apiKey, { mode: 0o600 });
          await verifyOcc();
          await applyGatewayApiKeySecret(helpers, platformNamespace, apiKeySecretName, apiKey);
          await helpers.waitFor("Envoy Gateway to reject the retired old API key", async () =>
            assertGatewayApiKeyDenied({ url: gatewayUrl, apiKey: oldApiKey })
              .then(() => true)
              .catch(() => undefined),
          );
          await helpers.waitFor("Envoy Gateway to keep accepting the rotated API key", async () =>
            assertGatewayApiKeyAccepted({ url: gatewayUrl, apiKey })
              .then(() => true)
              .catch(() => undefined),
          );
        },
      };
    },
  };
}

async function applyGatewayApiKeySecret({ applyManifest }, namespace, name, apiKeys) {
  const values = Array.isArray(apiKeys) ? apiKeys : [apiKeys];
  const entries = values
    .map(
      (value, index) =>
        `  ${index === 0 ? gatewayServiceKeyName : `${gatewayServiceKeyName}-${index}`}: ${yamlScalar(Buffer.from(value).toString("base64"))}`,
    )
    .join("\n");
  await applyManifest(
    `apiVersion: v1
kind: Secret
metadata:
  name: ${name}
  namespace: ${namespace}
type: Opaque
data:
${entries}
`,
    { redactions: values.flatMap((value) => [value, Buffer.from(value).toString("base64")]) },
  );
}

function registerRenderedExternalCleanup(context, manifests, platformNamespace, { kubectl }) {
  for (const object of renderedNamespacedObjects(manifests)) {
    if (object.kind !== "NetworkPolicy" || object.namespace === platformNamespace) {
      continue;
    }
    context.after(async () => {
      await kubectl(
        "delete",
        "networkpolicy",
        object.name,
        "--namespace",
        object.namespace,
        "--ignore-not-found=true",
      ).catch(() => undefined);
    });
  }
}

function renderedNamespacedObjects(manifests) {
  return manifests
    .split(/^---$/mu)
    .map((document) => {
      const kind = /^kind:\s*(\S+)\s*$/mu.exec(document)?.[1];
      const metadataStart = document.search(/^metadata:\s*$/mu);
      if (kind === undefined || metadataStart < 0) {
        return undefined;
      }
      const metadata = document.slice(metadataStart);
      const name = /^ {2}name:\s*(\S+)\s*$/mu.exec(metadata)?.[1];
      const namespace = /^ {2}namespace:\s*(\S+)\s*$/mu.exec(metadata)?.[1];
      return name === undefined || namespace === undefined
        ? undefined
        : { kind, name: unquoteYaml(name), namespace: unquoteYaml(namespace) };
    })
    .filter((object) => object !== undefined);
}

function unquoteYaml(value) {
  return value.replace(/^"|"$/g, "");
}

async function ensureCertificateAuthority(namespace, { applyManifest, waitFor, resource }) {
  const caCertPath = nonempty(
    process.env.OCC_TEST_GATEWAY_CA_CERT_PATH ?? process.env.NODE_EXTRA_CA_CERTS,
    "OCC_TEST_GATEWAY_CA_CERT_PATH or NODE_EXTRA_CA_CERTS",
  );
  const caKeyPath = nonempty(
    process.env.OCC_TEST_GATEWAY_CA_KEY_PATH,
    "OCC_TEST_GATEWAY_CA_KEY_PATH",
  );
  const [certificate, key] = await Promise.all([
    readFile(caCertPath, "utf8"),
    readFile(caKeyPath, "utf8"),
  ]);
  new X509Certificate(certificate);
  await applyManifest(
    `apiVersion: v1
kind: Secret
metadata:
  name: ${caSecretName}
  namespace: ${namespace}
type: kubernetes.io/tls
stringData:
  tls.crt: |
${certificate
  .trimEnd()
  .split("\n")
  .map((line) => `    ${line}`)
  .join("\n")}
  tls.key: |
${key
  .trimEnd()
  .split("\n")
  .map((line) => `    ${line}`)
  .join("\n")}
---
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: ${caIssuerName}
  namespace: ${namespace}
spec:
  ca:
    secretName: ${caSecretName}
`,
    { redactions: [key] },
  );
  await waitFor("cert-manager CA Issuer readiness", async () => {
    const issuer = await resource("issuer", caIssuerName, namespace);
    return issuer.status?.conditions?.some(
      ({ type, status }) => type === "Ready" && status === "True",
    )
      ? issuer
      : undefined;
  });
}

async function ensureGatewayClass({ applyManifest, waitFor, resource }, gatewayClassName) {
  await applyManifest(`apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: ${gatewayClassName}
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
`);
  await waitFor("Envoy GatewayClass acceptance", async () => {
    const gatewayClass = await resource("gatewayclass", gatewayClassName);
    return gatewayClass.status?.conditions?.some(
      ({ type, status }) => type === "Accepted" && status === "True",
    )
      ? gatewayClass
      : undefined;
  });
}

async function clusterPodCidrs({ kubectl }) {
  const nodes = JSON.parse(await kubectl("get", "nodes", "-o", "json")).items;
  const cidrs = nodes
    .flatMap((node) => node.spec?.podCIDRs ?? [node.spec?.podCIDR])
    .filter(Boolean);
  assert.ok(cidrs.length > 0, "The test requires observed Kubernetes Pod CIDRs.");
  return [...new Set(cidrs)];
}

async function waitForEnvoyService(platformNamespace, { resources, waitFor }) {
  return await waitFor("Envoy data-plane Service for workspace Gateway", async () => {
    const services = await resources(
      "services",
      envoyNamespace,
      "-l",
      `gateway.envoyproxy.io/owning-gateway-namespace=${platformNamespace},gateway.envoyproxy.io/owning-gateway-name=${gatewayName}`,
    );
    return services.find((service) => service.spec?.ports?.some(({ port }) => port === 443));
  });
}

async function waitForComputeGatewayRoute(topology, { resource, waitFor }) {
  const expectedMembership = hash(`${topology.platformNamespace}/${gatewayName}`);
  await waitFor("Compute-created tenant namespace gateway membership label", async () => {
    const namespace = await resource("namespace", topology.placement);
    return namespace.metadata?.labels?.["openclaw-enterprise.io/gateway"] === expectedMembership
      ? namespace
      : undefined;
  });
  return await waitFor(
    "Compute-created Agent HTTPRoute accepted by workspace Gateway",
    async () => {
      const route = await resource("httproute", topology.gatewayServiceName, topology.placement);
      const parent = route.status?.parents?.find(
        (entry) =>
          entry.parentRef?.name === gatewayName &&
          entry.parentRef?.namespace === topology.platformNamespace,
      );
      return parent?.conditions?.some(
        ({ type, status }) => type === "Accepted" && status === "True",
      )
        ? route
        : undefined;
    },
  );
}

async function startInClusterTcpForwarder(context, topology, helpers, envoyService) {
  const name = `oce-envoy-forwarder-${hash(topology.agent.id)}`;
  const targetHost = nonempty(
    envoyService.spec?.clusterIP,
    "Envoy data-plane Service clusterIP for test TCP transport",
  );
  await helpers.applyManifest(`apiVersion: v1
kind: Pod
metadata:
  name: ${name}
  namespace: ${topology.platformNamespace}
  labels:
    app.kubernetes.io/name: openclaw-enterprise
    app.kubernetes.io/instance: ${gatewayReleaseName}
    app.kubernetes.io/component: api
spec:
  restartPolicy: Never
  containers:
    - name: tcp-forwarder
      image: ${yamlScalar(topology.gatewayImage)}
      imagePullPolicy: IfNotPresent
      command: ["node", "-e"]
      args:
        - |
          const net = require("node:net");
          const targetHost = ${yamlScalar(targetHost)};
          const targetPort = 443;
          net.createServer((client) => {
            const upstream = net.connect(targetPort, targetHost);
            client.on("error", () => upstream.destroy());
            upstream.on("error", () => client.destroy());
            client.pipe(upstream);
            upstream.pipe(client);
          }).listen(${tcpForwarderPort}, "0.0.0.0");
      ports:
        - containerPort: ${tcpForwarderPort}
`);
  context.after(async () => {
    await helpers
      .kubectl(
        "delete",
        "pod",
        name,
        "--namespace",
        topology.platformNamespace,
        "--ignore-not-found=true",
      )
      .catch(() => undefined);
  });
  await helpers.kubectl(
    "wait",
    "--namespace",
    topology.platformNamespace,
    "--for=condition=Ready",
    `pod/${name}`,
    "--timeout=180s",
  );
  const forwarding = await helpers.startPortForwardTarget(
    topology.platformNamespace,
    `pod/${name}`,
    `0:${tcpForwarderPort}`,
  );
  context.after(() => forwarding.stop());
  // Docker Desktop owns privileged host port publishing; the test process stays unprivileged.
  // Both forwarders copy encrypted bytes only. Envoy remains the sole TLS/authentication proxy.
  const publisherName = `oce-envoy-publisher-${hash(topology.agent.id)}`;
  const localPort = Number(new URL(forwarding.url).port);
  const publisherImage = resolveGatewayPublisherImage(topology);
  await command("docker", [
    "run",
    "--detach",
    "--rm",
    "--pull=never",
    "--name",
    publisherName,
    "--publish",
    `127.0.0.1:443:${tcpForwarderPort}`,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user",
    "1000:1000",
    "--no-healthcheck",
    "--entrypoint",
    "node",
    publisherImage,
    "-e",
    `const net=require("node:net");net.createServer(client=>{const upstream=net.connect(${localPort},"host.docker.internal");client.on("error",()=>upstream.destroy());upstream.on("error",()=>client.destroy());client.pipe(upstream);upstream.pipe(client)}).listen(${tcpForwarderPort},"0.0.0.0")`,
  ]);
  context.after(async () => {
    await command("docker", ["rm", "--force", publisherName]);
  });
  await helpers.waitFor("private Gateway TLS through the test TCP transport", async () =>
    gatewayServedCertificate(`wss://${gatewayHostname}`).catch(() => undefined),
  );
}

async function waitForGatewayCertificate(platformNamespace, { resource, waitFor }) {
  return await waitFor("cert-manager workspace Gateway leaf certificate", async () => {
    try {
      const secret = await resource("secret", tlsSecretName, platformNamespace);
      return secret.data?.["tls.crt"] === undefined ? undefined : secret;
    } catch (error) {
      if (/NotFound|not found/i.test(error.stderr ?? error.message)) {
        return undefined;
      }
      throw error;
    }
  });
}

async function gatewayLeafCertificate(platformNamespace, { resource }) {
  const secret = await resource("secret", tlsSecretName, platformNamespace);
  assert.ok(secret.data?.["tls.crt"], "Gateway TLS Secret must contain a leaf certificate");
  return new X509Certificate(Buffer.from(secret.data["tls.crt"], "base64"));
}

async function waitForGatewayProgrammed(platformNamespace, { resource, waitFor }) {
  return await waitFor("workspace Gateway listener programmed by Envoy", async () => {
    const gateway = await resource("gateway", gatewayName, platformNamespace);
    const programmed = gateway.status?.conditions?.some(
      ({ type, status }) => type === "Programmed" && status === "True",
    );
    const accepted = gateway.status?.listeners?.some(
      (listener) =>
        listener.name === "https" &&
        listener.conditions?.some(({ type, status }) => type === "Accepted" && status === "True"),
    );
    return programmed && accepted ? gateway : undefined;
  });
}

async function gatewayServedCertificate(url) {
  const endpoint = new URL(url);
  return await new Promise((resolve, reject) => {
    const socket = connectTls({
      host: endpoint.hostname,
      port: Number(endpoint.port || "443"),
      servername: endpoint.hostname,
      rejectUnauthorized: true,
    });
    const fail = (error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(15_000, () => fail(new Error("TLS certificate probe timed out")));
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      const certificate = socket.getPeerCertificate(true);
      socket.end();
      if (!(certificate.raw instanceof Buffer)) {
        reject(new Error("TLS certificate probe did not return a raw peer certificate"));
        return;
      }
      resolve(new X509Certificate(certificate.raw));
    });
  });
}

async function assertGatewayAuthenticationDenials({ url, validApiKey }) {
  await assertGatewayApiKeyDenied({ url, apiKey: undefined });
  await assertGatewayApiKeyDenied({ url, apiKey: `invalid-${randomUUID()}` });
  await assertGatewayApiKeyDenied({
    url,
    apiKey: undefined,
    extraHeaders: { [gatewayIdentityHeader]: `spoofed-${randomUUID()}` },
  });
  await assertGatewayApiKeyAccepted({
    url,
    apiKey: validApiKey,
    extraHeaders: {
      [gatewayIdentityHeader]: `spoofed-${randomUUID()}`,
      "x-real-ip": "127.0.0.1",
      "x-forwarded-for": "127.0.0.1",
      forwarded: "for=127.0.0.1",
      "x-openclaw-scopes": "operator.read",
    },
  });
}

async function assertGatewayApiKeyAccepted({ url, apiKey, extraHeaders = {} }) {
  const hello = await requestGatewayHello({ url, apiKey, extraHeaders });
  assert.equal(hello.auth?.role, "operator");
  assert.ok(hello.auth.scopes.includes("operator.admin"));
  assert.equal(hello.auth.deviceToken, undefined, "trusted proxy must not issue a device token");
}

async function assertGatewayApiKeyDenied({ url, apiKey, extraHeaders = {} }) {
  await assert.rejects(
    () => requestGatewayHello({ url, apiKey, extraHeaders }),
    /\bHTTP (?:401|403)\b/i,
  );
}

async function requestGatewayHello({ url, apiKey, extraHeaders = {} }) {
  let resolveHello;
  let rejectHello;
  const connected = new Promise((resolve, reject) => {
    resolveHello = resolve;
    rejectHello = reject;
  });
  const client = new GatewayClient({
    url,
    clientName: "gateway-client",
    mode: "backend",
    role: "operator",
    scopes: [],
    deviceIdentity: null,
    edgeAuthHeaders: {
      ...(apiKey === undefined ? {} : { [gatewayServiceKeyHeader]: apiKey }),
      ...extraHeaders,
    },
    onHelloOk: resolveHello,
    onConnectError: rejectHello,
  });
  const timer = setTimeout(() => rejectHello(new Error("gateway hello timed out")), 15_000);
  try {
    client.start();
    return await connected;
  } finally {
    clearTimeout(timer);
    client.stop();
    await client.stopAndWait?.({ timeoutMs: 1_000 }).catch(() => undefined);
  }
}

async function assertDirectGatewayPeerDenied(context, topology, helpers, envoyService) {
  const name = `oce-envoy-denied-${hash(randomUUID())}`;
  const targetHost = nonempty(
    envoyService.spec?.clusterIP,
    "Envoy data-plane Service clusterIP for direct-denial probe",
  );
  const gatewayPodIp = nonempty(topology.gatewayPod.status?.podIP, "native gateway Pod IP");
  await helpers.applyManifest(`apiVersion: v1
kind: Pod
metadata:
  name: ${name}
  namespace: ${topology.platformNamespace}
  labels:
    app.kubernetes.io/name: openclaw-enterprise-denied-client
spec:
  restartPolicy: Never
  containers:
    - name: probe
      image: ${yamlScalar(topology.gatewayImage)}
      imagePullPolicy: IfNotPresent
      command: ["node", "-e"]
      args:
        - |
          const net = require("node:net");
          const denied = (host, port) => new Promise((resolve, reject) => {
            const socket = net.connect(port, host);
            socket.setTimeout(5000, () => { socket.destroy(); resolve(); });
            socket.once("error", resolve);
            socket.once("connect", () => { socket.destroy(); reject(new Error("Unlabeled peer reached " + host + ":" + port)); });
          });
          (async () => {
            await denied(${yamlScalar(targetHost)}, 443);
            await denied(${yamlScalar(gatewayPodIp)}, 8080);
          })().then(() => process.exit(0), (error) => { process.stderr.write(error.message); process.exit(2); });
`);
  context.after(async () => {
    await helpers
      .kubectl(
        "delete",
        "pod",
        name,
        "--namespace",
        topology.platformNamespace,
        "--ignore-not-found=true",
      )
      .catch(() => undefined);
  });
  await helpers.waitFor("unlabeled direct Envoy Gateway peer denial", async () => {
    const pod = await helpers.resource("pod", name, topology.platformNamespace);
    if (pod.status?.phase === "Succeeded") {
      return pod;
    }
    if (pod.status?.phase !== "Failed") {
      return undefined;
    }
    const logs = await helpers
      .kubectl("logs", name, "--namespace", topology.platformNamespace)
      .catch(() => "");
    assert.fail(`unlabeled direct Envoy Gateway peer was not denied: ${logs}`);
  });
}

export async function requestNativeGatewayModelTurn({
  url,
  apiKey,
  nativeAgentId = "main",
  prompt = "What is the configured workspace marker? Reply with only that marker.",
  expectedMarker,
  timeoutMs = 240_000,
}) {
  nonempty(expectedMarker, "expected workspace marker");
  assert.equal(
    prompt.includes(expectedMarker),
    false,
    "the user message must not supply the marker",
  );
  const sessionKey = `agent:${nativeAgentId}:workspace-proof-${randomUUID()}`;
  const signal = AbortSignal.timeout(timeoutMs);
  let resolveHello;
  let rejectHello;
  const connected = new Promise((resolve, reject) => {
    resolveHello = resolve;
    rejectHello = reject;
  });
  const client = new GatewayClient({
    url,
    clientName: "gateway-client",
    mode: "backend",
    role: "operator",
    scopes: [],
    deviceIdentity: null,
    edgeAuthHeaders: { [gatewayServiceKeyHeader]: apiKey },
    onHelloOk: resolveHello,
    onConnectError: rejectHello,
  });
  const connectTimer = setTimeout(
    () => rejectHello(new Error("native model proof connection timed out")),
    15_000,
  );
  try {
    client.start();
    const hello = await connected;
    clearTimeout(connectTimer);
    assert.equal(hello.auth?.role, "operator");
    assert.ok(hello.auth.scopes.includes("operator.admin"));
    assert.equal(hello.auth.deviceToken, undefined, "trusted proxy must not issue a device token");
    await client.request(
      "chat.send",
      {
        sessionKey,
        idempotencyKey: randomUUID(),
        message: prompt,
      },
      { signal, timeoutMs: 30_000 },
    );
    while (!signal.aborted) {
      const history = await client.request(
        "chat.history",
        { sessionKey, limit: 20 },
        { signal, timeoutMs: 10_000 },
      );
      for (const message of history.messages ?? []) {
        if (message.role !== "assistant") {
          continue;
        }
        assert.notEqual(
          message.stopReason,
          "error",
          "the provider-backed native turn must succeed",
        );
        const content =
          typeof message.content === "string"
            ? message.content
            : (message.content ?? [])
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n");
        if (content.includes(expectedMarker)) {
          return { sessionKey, content, deviceTokenIssued: false };
        }
      }
      await delay(300, undefined, { signal });
    }
    assert.fail("The fresh native session did not consume the workspace instruction.");
  } finally {
    clearTimeout(connectTimer);
    client.stop();
    await client.stopAndWait({ timeoutMs: 1_000 });
  }
}

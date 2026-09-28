import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as requestHttps } from "node:https";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const gatewayReleaseName = "oce-workspace-files";
const gatewayName = `${gatewayReleaseName}-agent-gateways`;
const gatewayServiceKeyName = "occ";
const gatewayIdentity = "occ-workspace-files";
const gatewayIdentityHeader = "x-occ-identity";
const envoyNamespace = process.env.OCC_TEST_ENVOY_GATEWAY_NAMESPACE ?? "envoy-gateway-system";
const certManagerNamespace = process.env.OCC_TEST_CERT_MANAGER_NAMESPACE ?? "cert-manager";
const caSecretName = "oce-workspace-files-ca";
const caIssuerName = "oce-workspace-files-ca";
const tlsSecretName = `${gatewayName}-tls`;
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

function hash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function gatewayHostname(platformNamespace) {
  return `occ-gateway-${hash(
    `${platformNamespace}/${gatewayName}`,
  )}.${envoyNamespace}.svc.cluster.local`;
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
  hostname,
  sandbox,
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
      // The disposable fixture has one node; production role isolation is verified separately.
      "--set-json",
      'controlPlane.nodeSelector={"kubernetes.io/os":"linux"}',
      "--show-only",
      "templates/gateway-routing.yaml",
      "--set",
      "gatewayRouting.enabled=true",
      "--set",
      `gatewayRouting.gatewayClassName=${gatewayClassName}`,
      "--set",
      `gatewayRouting.envoyNamespace=${envoyNamespace}`,
      "--set",
      `gatewayRouting.hostname=${hostname}`,
      "--set",
      `gatewayRouting.apiKeySecretName=${apiKeySecretName}`,
      "--set",
      `gatewayRouting.issuerRef.name=${caIssuerName}`,
      "--set",
      "gatewayRouting.issuerRef.kind=Issuer",
      "--set",
      "gatewayRouting.issuerRef.group=cert-manager.io",
      ...(sandbox === undefined
        ? []
        : ["--set-json", `gatewayRouting.sandbox=${JSON.stringify(sandbox)}`]),
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

export async function createEnvoyWorkspaceGatewayPlan(
  context,
  { platformNamespace, sandboxPreview = false },
  helpers,
) {
  let apiKey = randomBytes(32).toString("base64url");
  const apiKeySecretName = `oce-gateway-api-key-${hash(platformNamespace)}`;

  await applyGatewayApiKeySecret(helpers, platformNamespace, apiKeySecretName, apiKey);
  await ensureCertificateAuthority(platformNamespace, helpers);
  const sandbox = sandboxPreview
    ? {
        enabled: true,
        domain: `preview-${hash(platformNamespace)}.${envoyNamespace}.svc.cluster.local`,
        tlsSecretName: `${gatewayName}-sandbox-tls`,
        listenerPort: 8443,
        ingressPeers: [
          {
            namespaceSelector: {
              matchLabels: { "kubernetes.io/metadata.name": platformNamespace },
            },
            podSelector: { matchLabels: { "app.kubernetes.io/name": "approved-gateway-client" } },
          },
        ],
      }
    : undefined;
  if (sandbox !== undefined) {
    await helpers.applyManifest(
      JSON.stringify({
        apiVersion: "cert-manager.io/v1",
        kind: "Certificate",
        metadata: { name: sandbox.tlsSecretName, namespace: platformNamespace },
        spec: {
          secretName: sandbox.tlsSecretName,
          dnsNames: [`*.${sandbox.domain}`],
          issuerRef: { name: caIssuerName, kind: "Issuer" },
        },
      }),
    );
    await helpers.waitFor("sandbox certificate readiness", async () => {
      const certificate = await helpers.resource(
        "certificate",
        sandbox.tlsSecretName,
        platformNamespace,
      );
      return certificate.status?.conditions?.some(
        ({ type, status }) => type === "Ready" && status === "True",
      );
    });
  }
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
    hostname: gatewayHostname(platformNamespace),
    sandbox,
  });
  registerRenderedExternalCleanup(context, gatewayRoutingManifests, platformNamespace, helpers);
  await helpers.applyManifest(gatewayRoutingManifests);
  await waitForGatewayCertificate(platformNamespace, helpers);
  await waitForGatewayProgrammed(platformNamespace, helpers);

  return {
    get apiKey() {
      return apiKey;
    },
    apiKeySecretName,
    apiPodLabels: {
      "app.kubernetes.io/name": "openclaw-enterprise",
      "app.kubernetes.io/instance": gatewayReleaseName,
      "app.kubernetes.io/component": "api",
    },
    caSecretName,
    routing: {
      gatewayName,
      gatewayNamespace: platformNamespace,
      envoyNamespace,
      hostname: gatewayHostname(platformNamespace),
      ...(sandbox === undefined ? {} : { sandbox: { domain: sandbox.domain } }),
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
      await waitForGatewayProgrammed(platformNamespace, helpers);
      const gatewayUrl = `wss://${gatewayHostname(platformNamespace)}/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}`;
      const probe = (input) => runControllerProbe(topology, input);
      return {
        url: gatewayUrl,
        async assertSandboxPreview() {
          assert.ok(sandbox, "sandbox preview must be selected before provisioning");
          // The same native RPC used by the file panel starts the real sandbox
          // listener. Fetch through Envoy, retaining TLS and backend CNI checks.
          const preview = await probe({ action: "sandbox-preview", url: gatewayUrl, apiKey });
          const origin = new URL(preview.sandboxOrigin);
          assert(origin.hostname.endsWith(`.${sandbox.domain}`));
          assert.equal(origin.protocol, "https:");
          const forwarding = await helpers.startPortForwardTarget(
            envoyNamespace,
            `service/${envoyService.metadata.name}`,
            "0:8443",
          );
          try {
            const ca = await readFile(
              process.env.OCC_TEST_GATEWAY_CA_CERT_PATH ?? process.env.NODE_EXTRA_CA_CERTS,
            );
            const get = (path, method = "GET", hostname = origin.hostname) =>
              new Promise((resolve, reject) => {
                const req = requestHttps(
                  {
                    hostname: "127.0.0.1",
                    port: new URL(forwarding.url).port,
                    servername: origin.hostname,
                    ca,
                    method,
                    path,
                    headers: { host: hostname },
                  },
                  (res) => {
                    let body = "";
                    res.setEncoding("utf8");
                    res.on("data", (chunk) => {
                      body += chunk;
                    });
                    res.on("end", () =>
                      resolve({ status: res.statusCode, headers: res.headers, body }),
                    );
                  },
                );
                req.on("error", reject);
                req.setTimeout(10_000, () => req.destroy(new Error("sandbox ingress timeout")));
                req.end();
              });
            const shell = await get(preview.sandboxUrl);
            assert.equal(shell.status, 200, shell.body);
            assert.match(shell.headers["content-type"], /text\/html/);
            assert.match(shell.headers["content-security-policy"], /default-src 'none'/);
            assert.equal((await get(preview.sandboxUrl, "HEAD")).status, 200);
            assert.equal((await get(preview.sandboxUrl, "POST")).status, 404);
            assert.equal((await get("/api/config")).status, 404);
            assert.equal(
              (await get(preview.sandboxUrl, "GET", `unknown.${sandbox.domain}`)).status,
              404,
            );
          } finally {
            await forwarding.stop();
          }
        },
        requestModelTurn: (expectedMarker) =>
          probe({
            action: "model-turn",
            url: gatewayUrl,
            apiKey,
            expectedMarker,
          }),
        async assertSecurity() {
          await assertGatewayAuthenticationDenials(probe, {
            url: gatewayUrl,
            validApiKey: apiKey,
          });
          await assertDirectGatewayPeerDenied(context, topology, helpers, envoyService);
        },
        async assertNodeAuthentication() {
          const name = `${topology.gatewayServiceName}-node`;
          await helpers.waitFor("Compute-created native node route policy acceptance", async () => {
            const policy = await helpers.resource(
              "securitypolicy",
              name,
              topology.gatewayPlacement,
            );
            return policy.status?.ancestors?.some((ancestor) =>
              ancestor.conditions?.some(
                ({ type, status }) => type === "Accepted" && status === "True",
              ),
            );
          });
          await probe({
            action: "node-authentication",
            url: gatewayUrl,
            apiKey,
            gatewayIdentity,
            gatewayIdentityHeader,
          });
        },
        async renewCertificate() {
          const previous = await gatewayServedCertificate(probe, gatewayUrl);
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
              const candidate = await gatewayServedCertificate(probe, gatewayUrl).catch(
                () => undefined,
              );
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
            assertGatewayApiKeyAccepted(probe, { url: gatewayUrl, apiKey: newApiKey })
              .then(() => true)
              .catch(() => undefined),
          );
          await assertGatewayApiKeyAccepted(probe, { url: gatewayUrl, apiKey: oldApiKey });
          // Switch the mounted entry while retaining the old credential during propagation.
          await applyGatewayApiKeySecret(helpers, platformNamespace, apiKeySecretName, [
            newApiKey,
            oldApiKey,
          ]);
          apiKey = newApiKey;
          await verifyOcc();
          await applyGatewayApiKeySecret(helpers, platformNamespace, apiKeySecretName, apiKey);
          await helpers.waitFor("Envoy Gateway to reject the retired old API key", async () =>
            assertGatewayApiKeyDenied(probe, { url: gatewayUrl, apiKey: oldApiKey })
              .then(() => true)
              .catch(() => undefined),
          );
          await helpers.waitFor("Envoy Gateway to keep accepting the rotated API key", async () =>
            assertGatewayApiKeyAccepted(probe, { url: gatewayUrl, apiKey })
              .then(() => true)
              .catch(() => undefined),
          );
          await helpers.waitFor("OCC API to observe the rotated projected API key", async () =>
            verifyOcc()
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
    const namespace = await resource("namespace", topology.gatewayPlacement);
    return namespace.metadata?.labels?.["openclaw-enterprise.io/gateway"] === expectedMembership
      ? namespace
      : undefined;
  });
  return await waitFor(
    "Compute-created Agent HTTPRoute accepted by workspace Gateway",
    async () => {
      const route = await resource(
        "httproute",
        topology.gatewayServiceName,
        topology.gatewayPlacement,
      );
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

async function runControllerProbe(topology, input) {
  const kubeconfig = process.env.OCC_TEST_KUBERNETES_KUBECONFIG;
  const context = process.env.OCC_TEST_KUBERNETES_CONTEXT;
  const kubectl = process.env.OCC_KUBECTL_BIN ?? "kubectl";
  assert.ok(topology.controllerApiPod?.metadata?.name, "in-cluster OCC API Pod is required");
  return await new Promise((resolve, reject) => {
    const child = spawn(
      kubectl,
      [
        "--kubeconfig",
        kubeconfig,
        "--context",
        context,
        "exec",
        "-i",
        "--namespace",
        topology.platformNamespace,
        "--container",
        "api",
        topology.controllerApiPod.metadata.name,
        "--",
        "node",
        "/app/apps/controller/gateway-probe.mjs",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(JSON.parse(stdout));
      } else {
        reject(new Error(`in-cluster gateway probe failed (${code}): ${stderr}`));
      }
    });
    child.stdin.once("error", reject);
    child.stdin.end(JSON.stringify(input));
  });
}

async function gatewayServedCertificate(probe, url) {
  return await probe({ action: "certificate", url });
}

async function assertGatewayAuthenticationDenials(probe, { url, validApiKey }) {
  await assertGatewayApiKeyDenied(probe, { url, apiKey: undefined });
  await assertGatewayApiKeyDenied(probe, { url, apiKey: `invalid-${randomUUID()}` });
  await assertGatewayApiKeyDenied(probe, {
    url,
    apiKey: undefined,
    extraHeaders: { [gatewayIdentityHeader]: `spoofed-${randomUUID()}` },
  });
  await assertGatewayApiKeyAccepted(probe, {
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

async function assertGatewayApiKeyAccepted(probe, { url, apiKey, extraHeaders = {} }) {
  const hello = await probe({ action: "hello", url, apiKey, extraHeaders });
  assert.equal(hello.auth?.role, "operator");
  assert.ok(hello.auth.scopes.includes("operator.admin"));
  assert.equal(hello.auth.deviceToken, undefined, "trusted proxy must not issue a device token");
}

async function assertGatewayApiKeyDenied(probe, { url, apiKey, extraHeaders = {} }) {
  await assert.rejects(
    () => probe({ action: "hello", url, apiKey, extraHeaders }),
    /\bHTTP (?:401|403)\b|unexpected server response: (?:401|403)/i,
  );
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

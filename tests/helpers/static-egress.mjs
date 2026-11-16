import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { createCredentialProxyInstallationConfiguration } from "./installation-driver-configuration.mjs";
import { sandboxNamespaceLifecycleBinding } from "../../apps/controller/src/composition/namespace-lifecycle.ts";
import { TokenService } from "../../apps/controller/src/backends/token-service/service.ts";
import { githubMetadataProvider } from "../../apps/controller/src/drivers/egress-proxy/github-metadata.ts";
import {
  githubMetadataGrant,
  preparedGitHubProviderRef,
  preparedGitHubSourceFromRoute,
} from "../../packages/contracts/src/index.ts";
import { InstalledDriver } from "../../packages/occ/src/index.ts";
import { assertExecutionAdmission } from "../../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, randomBytes, sign } from "node:crypto";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { createConsoleAppFixture } from "./console-app.mjs";
import { createDevelopmentComputeDriver } from "./development.mjs";
import { createTestKubernetesComputeDriver } from "./kubernetes-compute.mjs";
import { KubernetesSecretDriver } from "../../apps/controller/src/drivers/secret/kubernetes/index.ts";
import { createOpenShellBackend } from "../../apps/controller/src/backends/openshell.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import { OpenShellCredentialProxyDriver } from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import { OpenShellEgressIdentity } from "../../apps/controller/src/drivers/egress-proxy/openshell-identity.ts";
import {
  createOpenShellEgressAuthority,
  bindOpenShellEgressAuthority,
} from "../../apps/controller/src/drivers/egress-proxy/openshell-authority.ts";
import { selfSigned } from "./certificates.mjs";
import { listen } from "./listen.ts";
import { requestId } from "./static-egress-request-id.ts";
import { temporaryDirectory } from "./temporary-directory.mjs";

export { requestId };
export { syntheticDispatchFixture } from "./static-egress-dispatch.ts";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const grpc = require("@grpc/grpc-js");
const loader = require("@grpc/proto-loader");
import { openShellExchangeCapabilities as capabilities } from "../../apps/controller/src/drivers/egress-proxy/openshell-exchange-capabilities.ts";

export const loadGatewayDefinition = (options) =>
  loader.loadSync(
    new URL(
      "../../apps/controller/src/drivers/sandbox/proto/openshell-gateway.proto",
      import.meta.url,
    ).pathname,
    { keepCase: true, enums: String, longs: String, ...options },
  );

export const wireTime = (millis) => ({
  seconds: Math.floor(millis / 1000),
  nanos: (millis % 1000) * 1e6,
});
export const unary = (client, method, request, metadata, timeoutMs = 5000) =>
  new Promise((resolve, reject) =>
    client[method](
      request,
      metadata ?? new grpc.Metadata(),
      { deadline: Date.now() + timeoutMs },
      (error, result) => (error ? reject(error) : resolve(result)),
    ),
  );
export function supervisorBearer(claims, privateKey) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "EdDSA", typ: "openshell-ext+jwt", kid: "fixture-key" });
  const signed = header + "." + encode(claims);
  return `Bearer ${signed}.${sign(null, Buffer.from(signed), privateKey).toString("base64url")}`;
}

/** Real app/auth/IAM/controller/Drivers. Storage and installed runtime observations are wire fixtures,
 * not a Kubernetes API server or an OpenShell supervisor. No authorization/provider logic is mocked.
 * @template {import("node:net").Server} [Provider=never]
 */
async function buildStaticEgressFixture(
  t,
  {
    appFactory = /** @type {(t: import("node:test").TestContext, options?: Parameters<typeof createConsoleAppFixture>[1]) => Promise<Awaited<ReturnType<typeof createConsoleAppFixture>> | Awaited<ReturnType<typeof import("./postgres-egress-app.mjs").postgresApp>>>} */ (
      createConsoleAppFixture
    ),
    driverConfigurations = /** @type {readonly import("../../packages/occ/src/index.ts").DriverConfigurationRegistration[]} */ ([]),
    includeLegacy = false,
    // Admission uses production composition; execution retains an already admitted owner.
    admissionOnly = false,
    gatewayOnly = false,
    protectedSourceOnly = false,
    proxyDriverId = "openshell-egress",
    now = () => new Date(),
    physicalPlacement = false,
    recordInstallation = true,
    inertProviderRule = false,
    serviceTransport,
    admitRevision = true,
    resolutionFinished,
    preparedGitHub,
    createPreparedGitHub,
    configurePreparedTokens,
    secretValue,
    admitSource,
    providerServer = /** @type {((tls: import("node:tls").TlsOptions, handle: import("node:http").RequestListener) => Provider) | undefined} */ (
      undefined
    ),
    credentialProxyCapacity = /** @type {import("../../packages/occ/src/credential-proxy.ts").CredentialProxyCapacity | undefined} */ (
      undefined
    ),
  } = {},
) {
  const directory = await temporaryDirectory(t, "oce-egress-wire-");
  // Only ephemeral test-generated material is used; no operator credential files are involved.
  const generated = await selfSigned(directory, {
    subjectAltName: "DNS:localhost,DNS:provider.example.test,IP:127.0.0.1",
  });
  // gRPC credentials take Buffers.
  const [key, cert] = [Buffer.from(generated.key), Buffer.from(generated.cert)];
  const certPath = generated.certPath;
  const objects = new Map();
  /** @type {import("../../packages/contracts/src/index.ts").Namespace} */
  let namespace;
  const namespaceResource = () => ({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: `oce-${createHash("sha256").update(namespace.id).digest("hex").slice(0, 15)}`,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/gateway-namespace": namespace.id,
        "openclaw.dev/namespace": namespace.id,
      },
      annotations: { "openclaw.dev/namespace-id": namespace.id },
    },
    status: { phase: "Active" },
  });
  let runtimeNamespace;
  let secretReads = 0;
  let secretReadBarrier;
  let beforeNamespaceResponse;
  const kube = createHttpsServer({ key, cert }, async (request, response) => {
    response.setHeader("content-type", "application/json");
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/api/v1/namespaces") {
      await beforeNamespaceResponse?.();
      const nsId = namespace.id;
      assert.ok(
        [`openclaw.dev/gateway-namespace=${nsId}`, `openclaw.dev/namespace=${nsId}`].includes(
          url.searchParams.get("labelSelector"),
        ),
      );
      response.end(
        JSON.stringify({
          apiVersion: "v1",
          kind: "NamespaceList",
          items: [namespaceResource()],
        }),
      );
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === `/api/v1/namespaces/${namespaceResource().metadata.name}`
    ) {
      response.end(JSON.stringify(namespaceResource()));
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === `/apis/apps/v1/namespaces/${namespaceResource().metadata.name}/deployments`
    ) {
      response.end(JSON.stringify({ apiVersion: "apps/v1", kind: "DeploymentList", items: [] }));
      return;
    }
    const parts = url.pathname.split("/");
    const bytes = await buffer(request);
    const body = bytes.length ? JSON.parse(bytes) : undefined;
    const name = parts[6] || body?.metadata?.name;
    const previous = objects.get(name);
    if (request.method === "POST" || request.method === "PUT") {
      if (
        previous &&
        request.method === "PUT" &&
        body.metadata.resourceVersion !== previous.metadata.resourceVersion
      ) {
        response.writeHead(409).end(JSON.stringify({ code: 409 }));
        return;
      }
      const stored = {
        ...body,
        metadata: {
          ...body.metadata,
          uid: previous?.metadata.uid ?? randomUUID(),
          resourceVersion: String(Number(previous?.metadata.resourceVersion ?? 0) + 1),
        },
        data: Object.fromEntries(
          Object.entries(body.stringData).map(([field, value]) => [
            field,
            Buffer.from(value).toString("base64"),
          ]),
        ),
      };
      delete stored.stringData;
      objects.set(name, stored);
      response.writeHead(request.method === "POST" ? 201 : 200).end(JSON.stringify(stored));
    } else if (request.method === "GET" && previous) {
      secretReads += 1;
      await secretReadBarrier;
      response.end(JSON.stringify(previous));
    } else {
      response.writeHead(404).end(JSON.stringify({ code: 404 }));
    }
  });
  const kubePort = await listen(t, kube);
  const kubeconfigPath = join(directory, "fixture-kubeconfig.json");
  await writeFile(
    kubeconfigPath,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [
        {
          name: "fixture",
          cluster: {
            server: `https://127.0.0.1:${kubePort}`,
            "certificate-authority-data": cert.toString("base64"),
          },
        },
      ],
      users: [{ name: "fixture", user: {} }],
      contexts: [{ name: "fixture", context: { cluster: "fixture", user: "fixture" } }],
      "current-context": "fixture",
    }),
  );
  const secretDriver = new KubernetesSecretDriver({
    authentication: { mode: "kubeconfig", kubeconfigPath, context: "fixture" },
  });

  const materialReads = { ordinary: 0, versioned: 0 };
  for (const [method, counter] of [
    ["withValue", "ordinary"],
    ["readCredentialInput", "versioned"],
  ]) {
    const original = secretDriver[method].bind(secretDriver);
    secretDriver[method] = (...args) => {
      materialReads[counter] += 1;
      return original(...args);
    };
  }

  const Gateway = grpc.loadPackageDefinition(loadGatewayDefinition()).openshell.v1.OpenShell;
  const gateway = new grpc.Server();
  const observed = {
    available: true,
    sandbox: undefined,
    policy: undefined,
    deleted: [],
    workspaceVisible: true,
    policyStatusRequests: 0,
    gatewayInfoRequests: 0,
    policyStatusUnavailable: false,
  };
  // OpenShell reports negotiated capabilities in lexical order, including the base contract.
  const gatewayCapabilities = ["openshell.supervisor-middleware.contract", ...capabilities].sort();
  const profiles = new Map();
  const providers = new Map();
  const gatewayRequests = [];
  gateway.addService(Gateway.service, {
    Health(_call, callback) {
      callback(null, { status: "SERVICE_STATUS_HEALTHY" });
    },
    GetProviderProfile(call, callback) {
      const profile = profiles.get(call.request.id);
      callback(profile ? null : { code: grpc.status.NOT_FOUND }, profile ? { profile } : undefined);
    },
    ImportProviderProfiles(call, callback) {
      for (const item of call.request.profiles) {
        profiles.set(item.profile.id, { ...item.profile, resource_version: "1" });
      }
      callback(null, { imported: true });
    },
    CreateProvider(call, callback) {
      const provider = {
        ...call.request.provider,
        metadata: { ...call.request.provider.metadata, id: randomUUID(), resource_version: "1" },
      };
      providers.set(provider.metadata.name, provider);
      callback(null, { provider });
    },
    GetProvider(call, callback) {
      const provider = providers.get(call.request.name);
      gatewayRequests.push({ method: "GetProvider", request: call.request, found: !!provider });
      callback(
        provider ? null : { code: grpc.status.NOT_FOUND },
        provider ? { provider } : undefined,
      );
    },
    UpdateProvider(call, callback) {
      gatewayRequests.push({ method: "UpdateProvider", request: call.request });
      const previous = providers.get(call.request.provider.metadata.name);
      if (!previous) {
        callback({ code: grpc.status.NOT_FOUND });
        return;
      }
      const provider = {
        ...previous,
        metadata: {
          ...previous.metadata,
          resource_version: String(Number(previous.metadata.resource_version) + 1),
        },
        credentials: { ...previous.credentials, ...call.request.provider.credentials },
      };
      providers.set(provider.metadata.name, provider);
      callback(null, { provider });
    },
    DeleteProvider(call, callback) {
      gatewayRequests.push({ method: "DeleteProvider", request: call.request });
      const deleted = providers.delete(call.request.name);
      if (!deleted && !call.request.allow_missing) {
        callback({ code: grpc.status.NOT_FOUND });
        return;
      }
      callback(null, {
        outcome: deleted ? "DELETION_OUTCOME_COMPLETED" : "DELETION_OUTCOME_ALREADY_ABSENT",
      });
    },
    DeleteProviderProfile(call, callback) {
      gatewayRequests.push({ method: "DeleteProviderProfile", request: call.request });
      const deleted = profiles.delete(call.request.id);
      if (!deleted && !call.request.allow_missing) {
        callback({ code: grpc.status.NOT_FOUND });
        return;
      }
      callback(null, {
        outcome: deleted ? "DELETION_OUTCOME_COMPLETED" : "DELETION_OUTCOME_ALREADY_ABSENT",
      });
    },
    GetGatewayInfo(_call, callback) {
      observed.gatewayInfoRequests += 1;
      callback(null, {
        status: 1,
        extensions: observed.available
          ? [
              {
                kind: 4,
                configured_name: "oce-authority",
                protocol_major: 1,
                supported_capabilities: observed.supportedCapabilities ?? gatewayCapabilities,
                required_capabilities: observed.requiredCapabilities ?? gatewayCapabilities,
              },
            ]
          : [],
      });
    },
    // A missing Sandbox is absent only once the Workspace read passes (findings 1676, 2055).
    GetWorkspace(call, callback) {
      if (!observed.workspaceVisible) {
        callback({ code: grpc.status.PERMISSION_DENIED, details: "workspace role revoked" });
        return;
      }
      callback(null, {
        workspace: {
          metadata: {
            name: call.request.name,
            labels: {
              "app.kubernetes.io/managed-by": "openclaw-enterprise",
              "openclaw.dev/namespace-id": namespace.id,
            },
          },
          status: { phase: "WORKSPACE_PHASE_ACTIVE" },
        },
      });
    },
    GetSandbox(call, callback) {
      if (!observed.sandbox || call.request.workspace_scope.workspace !== runtimeNamespace.name) {
        callback({ code: grpc.status.NOT_FOUND });
        return;
      }
      assert.equal(call.request.name, observed.sandbox.name);
      callback(null, {
        sandbox: { metadata: observed.sandbox, status: { phase: "SANDBOX_PHASE_READY" } },
      });
    },
    GetService(call, callback) {
      if (
        !observed.service ||
        call.request.sandbox !== observed.sandbox?.name ||
        call.request.workspace_scope.workspace !== runtimeNamespace.name
      ) {
        callback({ code: grpc.status.NOT_FOUND });
        return;
      }
      callback(null, observed.service);
    },
    GetSandboxPolicyStatus(call, callback) {
      observed.policyStatusRequests += 1;
      if (observed.policyStatusUnavailable) {
        callback({ code: grpc.status.UNAVAILABLE });
        return;
      }
      if (call.request.workspace_scope.workspace !== runtimeNamespace.name) {
        callback({ code: grpc.status.NOT_FOUND });
        return;
      }
      callback(null, {
        revision: {
          version: 1,
          status: 2,
          policy: observed.policy,
          policy_hash: observed.policyHash,
        },
        loaded_enforcement:
          observed.evidence?.policy_hash === observed.policyHash ? observed.evidence : undefined,
        loaded_policy_observation: observed.observation
          ? { ...observed.observation, enforcement: observed.evidence }
          : undefined,
        active_version: 1,
      });
    },
    DeleteSandbox(call, callback) {
      observed.deleted.push(call.request);
      const sandboxId = observed.sandbox?.id;
      observed.sandbox = undefined;
      callback(null, { outcome: "DELETION_OUTCOME_COMPLETED", sandbox_id: sandboxId });
    },
  });
  const gatewayPort = await new Promise((resolve, reject) =>
    gateway.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createSsl(null, [{ cert_chain: cert, private_key: key }], false),
      (error, port) => (error ? reject(error) : resolve(port)),
    ),
  );
  t.after(() => gateway.forceShutdown());
  const transport = new GrpcOpenShellGatewayClient({
    endpoint: `https://127.0.0.1:${gatewayPort}`,
    rootCertificatePath: certPath,
  });
  // The fixture's gRPC metadata and local Harness HTTP listener occupy separate
  // ports. Both transports are production clients; no enrollment decision is mocked.
  const gatewayClient =
    serviceTransport === undefined
      ? transport
      : new Proxy(transport, {
          get(target, property) {
            const owner = [
              "getServiceDocument",
              "postServiceDocument",
              "serviceWebSocketHandshake",
            ].includes(property)
              ? serviceTransport
              : target;
            const value = owner[property];
            return typeof value === "function" ? value.bind(owner) : value;
          },
        });
  const backend = createOpenShellBackend(
    {
      id: "openshell-test",
      type: "openshell",
      configuration: {
        endpoint: `https://127.0.0.1:${gatewayPort}`,
        rootCertificatePath: certPath,
      },
      drivers: {
        sandbox: "openshell-sandbox",
        credential_gateway: "openshell-credentials",
        credential_proxy: proxyDriverId,
      },
    },
    { gatewayClient },
  );
  t.after(() => backend.client.close());
  const egressOptions = { middlewareName: "oce-authority", authorityScope: "execution" };
  let admissionDrivers;
  if (admissionOnly) {
    // Exercise startup's retirement selection, not a policy recreated by the fixture.
    const base = createCredentialProxyInstallationConfiguration();
    const configuration = {
      ...base,
      backend: [
        {
          ...base.backend[0],
          id: backend.id,
          configuration: {
            ...base.backend[0].configuration,
            endpoint: `https://127.0.0.1:${gatewayPort}`,
            rootCertificatePath: certPath,
          },
        },
      ],
    };
    const path = join(directory, "installation.json");
    await writeFile(path, JSON.stringify(configuration));
    const loaded = await loadInstallationConfiguration({
      mode: "development",
      environment: { OCC_CONFIG_PATH: path },
      createOpenShellBackend: () => backend,
    });
    assert.ok(loaded?.protectedDriver);
    assert.ok(loaded.sandboxDriver instanceof OpenShellSandboxDriver);
    assert.ok(loaded.proxyDriver instanceof OpenShellCredentialProxyDriver);
    assert.ok(loaded.credentialGatewayDriver instanceof OpenShellCredentialGatewayDriver);
    admissionDrivers = {
      owner: loaded.protectedDriver,
      sandbox: loaded.sandboxDriver,
      proxy: loaded.proxyDriver,
      catalog: loaded.credentialGatewayDriver,
    };
  }
  const sandbox =
    admissionDrivers?.sandbox ??
    new OpenShellSandboxDriver(
      {
        egress: egressOptions,
        gateway: { workspaceMode: "operator" },
        kubernetes: {
          runtimeClassName: "openshell-sandbox",
          serviceAccount: { mode: "gatewayConfigured" },
          sandboxDataMount: {
            subPath: "workspace",
            mountPath: "/sandbox/enterprise",
            readOnly: false,
          },
        },
        policy: {
          process: { runAsUser: "1000", runAsGroup: "1000" },
          networkPolicies: [
            {
              name: "inference",
              endpoints: [{ host: "provider.example.test", ports: [443] }],
              binaries: [{ path: "/usr/bin/model-client" }],
            },
          ],
        },
      },
      { id: "openshell-sandbox", backend },
    );
  const preparedTokens = new TokenService();
  const owner = createPreparedGitHub
    ? await createPreparedGitHub({ secretDriver, tokenService: preparedTokens })
    : preparedGitHub;
  const preparedProvider = configurePreparedTokens?.(preparedTokens);
  if (preparedGitHub) {
    preparedTokens.registerIssuer({
      tokenKind: "github_app_installation",
      provider: preparedGitHubProviderRef,
      sourceFromRoute: preparedGitHubSourceFromRoute,
      issuerInput: "private_key",
      issuerAuthority: "fixture-github-metadata",
      admission(config) {
        return { origin: owner.apiOrigin, grant: githubMetadataGrant(config), schemaVersion: 2 };
      },
      configure: (...args) => owner.configure(...args),
      resolve: (...args) => owner.resolve(...args),
      ready: (...args) => owner.ready(...args),
      withdraw: (...args) => owner.withdraw(...args),
    });
  }
  const providerRequests = [];
  let providerResponse = { status: 200, body: { output: "fixture answer" } };
  const createProvider = providerServer === undefined ? createHttpsServer : providerServer;
  const provider = createProvider({ key, cert }, async (request, response) => {
    const bytes = await buffer(request);
    providerRequests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      body: bytes.length ? JSON.parse(bytes) : undefined,
      headers: request.headers,
    });
    response.writeHead(providerResponse.status, {
      "content-type": providerResponse.contentType ?? "application/json",
    });
    response.write(providerResponse.rawBody ?? JSON.stringify(providerResponse.body));
    if (providerResponse.trailers) {
      response.addTrailers(providerResponse.trailers);
    }
    response.end();
  });
  const providerPort = await listen(t, provider);
  const modelProvider = {
    protocol: "openai-responses",
    baseUrl: `https://provider.example.test:${providerPort}/v1`,
  };
  const egress =
    admissionDrivers?.proxy ??
    new OpenShellCredentialProxyDriver(egressOptions, {
      id: proxyDriverId,
      preparedProviders: preparedProvider
        ? [preparedProvider]
        : owner
          ? [githubMetadataProvider]
          : [],
      backend,
      sandbox,
    });
  const catalog =
    admissionDrivers?.catalog ??
    new OpenShellCredentialGatewayDriver(
      { binaries: ["/usr/bin/model-client"] },
      { id: "openshell-credentials", backend },
    );
  const gatewayEffects = [];
  for (const method of ["registerSource", "updateSource", "removeSource"]) {
    const original = catalog[method].bind(catalog);
    catalog[method] = (...args) => {
      gatewayEffects.push(method);
      return original(...args);
    };
  }
  const placement = createTestKubernetesComputeDriver("placement", {
    gatewayRuntime: true,
    modelProvider,
    authentication: { mode: "kubeconfig", kubeconfigPath, context: "fixture" },
  });
  const computeDriver = {
    ...createDevelopmentComputeDriver(),
    normalizeHarnessOverrides: placement.normalizeHarnessOverrides.bind(placement),
    resolveHarnessConfiguration: placement.resolveHarnessConfiguration.bind(placement),
    validateHarnessCredentialSources: placement.validateHarnessCredentialSources.bind(placement),
    // Schema/protocol fixture only: no workload is released by this Compute.
    validateExecutionAdmission: assertExecutionAdmission,
    async resolveSandboxNamespace(value) {
      return physicalPlacement ? placement.resolveSandboxNamespace(value) : value;
    },
  };
  computeDriver.resolveSandboxNamespaceContext = async (value, signal) => ({
    namespace: await computeDriver.resolveSandboxNamespace(value),
    kubernetes: {},
    signal,
  });
  const installedDriver =
    admissionDrivers?.owner ??
    new InstalledDriver(
      { id: sandbox.id, implementation: sandbox.implementation, configuration: egressOptions },
      { capabilities: { sandbox, credential_proxy: egress } },
      { sandbox: sandbox.id, credential_proxy: egress.id },
    );
  const app = await appFactory(t, {
    now,
    provisionedPeople: [],
    preparedTokens,
    ...(credentialProxyCapacity === undefined ? {} : { credentialProxyCapacity }),
    driverConfigurations: [
      {
        capability: "sandbox",
        driverId: sandbox.id,
        implementation: sandbox.implementation,
        definition: OpenShellSandboxDriver,
      },
      ...driverConfigurations,
    ],
    preparedTokenProof: preparedGitHub && { current: (...args) => owner.current(...args) },
    secretDriver,
    computeDriver,
    namespaceLifecycleBindings: [
      sandboxNamespaceLifecycleBinding(computeDriver, sandbox, installedDriver),
    ],
  });
  await app.bootstrap();
  if (!protectedSourceOnly) {
    app.controller.registerDriver(catalog);
    app.controller.selectDriver(catalog.capability, catalog.id);
  }
  app.controller.registerDriver(installedDriver);
  app.controller.selectDriver("sandbox", sandbox.id);
  namespace = await app.createNamespace(`egress-${randomUUID().slice(0, 8)}`);
  runtimeNamespace = physicalPlacement
    ? await placement.resolveSandboxNamespace(namespace)
    : namespace;
  // The protocol's owned Workspace is now addressable before Namespace reconciliation.
  const ready = await app.controller.handleNamespaceLifecycle(
    app.principal.id,
    namespace.id,
    "ready",
  );
  assert.equal(ready.status, "ready");
  namespace = ready;
  runtimeNamespace = physicalPlacement
    ? await placement.resolveSandboxNamespace(namespace)
    : namespace;
  const post = async (resource, body) => {
    const result = await app.request("POST", `/namespaces/${namespace.id}/${resource}`, { body });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.data;
  };
  const secret = await post("secrets", { name: "provider-key", value: "synthetic-key-initial" });
  const path = `/namespaces/${namespace.id}/credential-sources`;
  let legacySource;
  if (includeLegacy) {
    legacySource = await post("credential-sources", {
      name: "approved-copy",
      type: "openai",
      config: { authorized_base_url: modelProvider.baseUrl },
      secrets: { api_key: secret.ref },
    });
  }
  if (!gatewayOnly) {
    app.controller.selectDriver("credential_proxy", egress.id);
  }
  const admissionControls = {
    modelProvider,
    namespace,
    secret,
    path,
    providers,
    profiles,
    gatewayRequests,
    providerRequests,
    gatewayEffects,
    materialReads,
    legacySource,
    egress,
    observed,
  };
  if (admissionOnly) {
    return {
      ...app,
      ...admissionControls,
      fixtureKind: /** @type {const} */ ("admission"),
      countSecretReads: () => secretReads,
    };
  }
  let source = protectedSourceOnly
    ? undefined
    : await post("credential-sources", {
        name: "inference",
        type: "openai",
        config: { authorized_base_url: `https://provider.example.test:${providerPort}/v1` },
        secrets: { api_key: secret.ref },
      });
  const config = await app.createConfiguration(namespace.id, {
    agents: {
      defaults: {
        model: { primary: "codex/fixture-model" },
        models: { "codex/fixture-model": { agentRuntime: { id: "codex" } } },
      },
    },
  });
  let agent = await post("agents", {
    name: "inference-agent",
    configurationId: config.id,
    executionMode: "dedicated",
    ...(protectedSourceOnly
      ? { harnessAuth: { method: "runtime" } }
      : {
          harnessAuth: { method: "credential_source", sourceId: source.id },
          credentialSources: [{ sourceId: source.id }],
        }),
  });
  if (admitSource) {
    // A prepared provider may have a distinct issuer input; never pass it to the inference source.
    const issuer =
      secretValue === undefined
        ? secret
        : await post("secrets", { name: "prepared-github-issuer", value: secretValue });
    ({ agent, source } = await admitSource({
      app,
      agent,
      namespace,
      secret: issuer,
      path,
      countSecretReads: () => secretReads,
      origin: `https://provider.example.test:${providerPort}`,
      computeAuthentication: { mode: "kubeconfig", kubeconfigPath, context: "fixture" },
    }));
  }
  // Grant the real service principal through the supported policy API. Revocation later
  // commits between independent RPC transactions and must affect the final send check.
  const role = await post("iam/roles", {
    name: "inference-use",
    permissions: [{ action: "operate", resourceKind: "credential_source" }],
  });
  const grant = await post("iam/access-bindings", {
    subjectKind: "identity",
    subjectId: agent.servicePrincipalId,
    roleId: role.id,
    resourceKind: "credential_source",
    resourceId: source.id,
  });
  if (!admitRevision) {
    return {
      ...app,
      ...admissionControls,
      fixtureKind: /** @type {const} */ ("undeployed"),
      agent,
      source,
      grant,
      countSecretReads: () => secretReads,
    };
  }
  const revisionMetadata = await app.deployAgent(namespace.id, agent.id);
  const revision = await app.controller.transact((unit) =>
    unit.revisions.findRevision(namespace.id, agent.id, revisionMetadata.id),
  );
  assert.ok(revision.egressPlan, "deployment must admit the consumed protected plan");
  const context = {
    namespace: runtimeNamespace,
    revision,
    plan: revision.egressPlan,
    signal: AbortSignal.timeout(5000),
  };
  const routes = await egress.configureRevision(context);
  // Passive full-source fixture standing in for the paired Sandbox's prepared
  // policy. This does not execute provisioning or attest supervisor installation.
  const attachment = {
    ...routes,
    configuration: {
      version: 1,
      filesystem: { read_only: ["/usr"], read_write: ["/tmp"] },
      landlock: { compatibility: "hard_requirement" },
      process: { run_as_user: "1000", run_as_group: "1000" },
      ...routes.configuration,
    },
  };
  const ref = sandbox.harnessResource(context);
  const sandboxId = randomUUID();
  // This is an authenticated gateway-observation fixture, not supervisor execution proof.
  observed.sandbox = {
    id: sandboxId,
    name: ref.resourceName,
    phase: "SANDBOX_PHASE_READY",
    annotations: {
      "openclaw.dev/namespace-id": namespace.id,
      "openclaw.dev/agent-id": agent.id,
      "openclaw.dev/revision-id": revision.id,
    },
  };
  observed.policy = structuredClone({ version: 1, ...attachment.configuration });
  assert.equal(
    await egress.wiringStatus(context, attachment),
    undefined,
    "a loaded gateway policy without an applied-capability receipt must not become ready",
  );
  // Supplier observations are fixtures; the production adapter must consume their
  // exact protobuf shape. No hand-written installation bypasses its readiness checks.
  const exchangeKeys = generateKeyPairSync("ed25519");
  observed.policyHash = "1a".repeat(32);
  observed.evidence = {
    sandbox_id: sandboxId,
    instance_id: randomUUID(),
    policy_version: 1,
    policy_hash: observed.policyHash,
    config_revision: "17395563786422799999",
    provider_env_revision: "9019556378642279999",
    enforced_capabilities: capabilities,
  };
  const effectivePolicy = structuredClone(observed.policy);
  const ruleName = inertProviderRule
    ? `_provider_oce_runtime_${createHash("sha256").update(revision.id).digest("hex").slice(0, 16)}`
    : "";
  if (inertProviderRule) {
    effectivePolicy.network_policies[ruleName] = { name: ruleName };
    observed.evidence.policy_hash = "3c".repeat(32);
  }
  observed.observation = {
    source_policy_hash: observed.policyHash,
    effective_policy: effectivePolicy,
    inert_provider_rule: ruleName,
    registered_exchange_public_key: Buffer.from(
      exchangeKeys.publicKey.export({ format: "jwk" }).x,
      "base64url",
    ),
  };
  const installation = await egress.wiringStatus(context, attachment);
  assert.ok(installation, "the adapter must validate the complete supplier observation");
  if (recordInstallation) {
    await app.controller.transact((unit) =>
      unit.credentialSources.recordEgressInstallation(installation),
    );
    await app.activateRevision(namespace.id, agent.id, revision.id);
  }

  const keys = generateKeyPairSync("ed25519");
  const identity = new OpenShellEgressIdentity({
    issuer: "https://gateway.example.test",
    audience: "oce-egress",
    keyId: "fixture-key",
    publicKey: keys.publicKey.export({ format: "pem", type: "spki" }),
    sender: egress.sourceControl.sender,
  });
  // The optional observer lets a test wait until queued work finishes *after* its
  // actual duplex was closed. It cannot substitute an identity, owner or result.
  const authorityController = resolutionFinished
    ? {
        createCredentialProxy(...args) {
          const forwarder = app.controller.createCredentialProxy(...args);
          const resolve = forwarder.resolve.bind(forwarder);
          forwarder.resolve = async (...input) => {
            const result = await resolve(...input);
            resolutionFinished(result);
            return result;
          };
          return forwarder;
        },
      }
    : app.controller;
  let authority = createOpenShellEgressAuthority(identity, authorityController);
  const authorityPort = await bindOpenShellEgressAuthority(authority, "127.0.0.1:0", cert, key);
  t.after(() => authority.forceShutdown());
  const definition = loader.loadSync(
    new URL(
      "../../apps/controller/src/drivers/egress-proxy/proto/supervisor_middleware.proto",
      import.meta.url,
    ).pathname,
    { keepCase: true, longs: String, enums: Number, defaults: false, oneofs: true },
  );
  /** @param {Uppercase<import("../../packages/contracts/src/index.ts").EgressRefusal["kind"]> | "UNSPECIFIED"} name
   * @returns {number} */
  const refusalCode = (name) => {
    const entry = definition["openshell.middleware.v1.HttpCredentialRefusalCode"].type.value.find(
      (value) => value.name === `HTTP_CREDENTIAL_REFUSAL_CODE_${name}`,
    );
    assert.ok(typeof entry?.number === "number", `Unknown HTTP credential refusal code: ${name}`);
    return entry.number;
  };
  const services = grpc.loadPackageDefinition(definition).openshell.middleware.v1;
  function createAuthorityClient(name) {
    // Keep the connection on IPv4 loopback and verify the certificate's DNS SAN.
    return new services[name](`127.0.0.1:${authorityPort}`, grpc.credentials.createSsl(cert), {
      "grpc.ssl_target_name_override": "localhost",
    });
  }
  const clients = Object.fromEntries(
    [
      "HttpCredentialAccess",
      "HttpResponsePreReturn",
      "SupervisorMiddleware",
      "HttpInstallationExchange",
    ].map((name) => [name, createAuthorityClient(name)]),
  );
  t.after(() => {
    for (const client of Object.values(clients)) {
      client.close();
    }
  });
  const supervisorClaims = () => {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: "https://gateway.example.test",
      aud: "oce-egress",
      sub: `spiffe://openshell/sandbox/${sandboxId}`,
      iat: now,
      exp: now + 60,
      jti: randomUUID(),
      caller_kind: "supervisor",
      sandbox_id: sandboxId,
      instance_id: installation.enforcement.instanceId,
      exchange_key: {
        profile: "openshell-exchange-v1",
        ...exchangeKeys.publicKey.export({ format: "jwk" }),
      },
    };
  };
  /** @param {Partial<Record<keyof ReturnType<typeof supervisorClaims>, unknown>>} [overrides]
   * @returns {import("./openshell-grpc-sdk.ts").Grpc.Metadata} */
  const metadata = (overrides = {}) => {
    const token = supervisorBearer({ ...supervisorClaims(), ...overrides }, keys.privateKey);
    const result = new grpc.Metadata();
    result.set("authorization", token);
    return result;
  };
  /** @typedef {{ seconds: string | number, nanos: number }} ExchangeTimestamp */
  /** @returns {{
   *   audience: string,
   *   deadline: ExchangeTimestamp,
   *   response_custody: Buffer,
   *   verified_execution_policy_hash: string,
   *   request: {
   *     context: { request_id: string, sandbox_id: string },
   *     target: { scheme: string, host: string, port: number, method: string, path: string },
   *     headers: { name: string, value: string }[],
   *     body: Buffer,
   *   },
   * }} */
  const capture = (body = { model: "fixture-model", input: "hello", store: false }) => ({
    audience: "oce-egress",
    deadline: wireTime(now().getTime() + 20_000),
    response_custody: randomBytes(32),
    verified_execution_policy_hash: installation.enforcement.policyHash,
    request: {
      context: {
        request_id: requestId(now().getTime()),
        sandbox_id: sandboxId,
      },
      target: {
        scheme: "https",
        host: "provider.example.test",
        port: providerPort,
        method: "POST",
        path: "/v1/responses",
      },
      headers: [{ name: "content-type", value: "application/json" }],
      body: Buffer.from(JSON.stringify(body)),
    },
  });
  function permitRequest(captured, ready, { noMaterial = false } = {}) {
    const hash = createHash("sha256");
    for (const header of noMaterial ? [] : ready.credential_headers) {
      for (const value of [header.name, header.value]) {
        const bytes = Buffer.from(value);
        const length = Buffer.alloc(8);
        length.writeBigUInt64BE(BigInt(bytes.length));
        hash.update(length).update(bytes);
      }
    }
    return {
      context: captured.request.context,
      operation_handle: ready.operation_handle,
      audience: "oce-egress",
      deadline: captured.deadline,
      ...(noMaterial ? { no_material_required: true } : { evidence: ready.evidence }),
      credential_headers_sha256: hash.digest(),
    };
  }
  async function send(captured, ready) {
    return new Promise((resolve, reject) => {
      const outgoing = httpsRequest(
        {
          hostname: "127.0.0.1",
          servername: "provider.example.test",
          ca: cert,
          port: providerPort,
          method: captured.request.target.method,
          path: captured.request.target.path,
          headers: Object.fromEntries(
            [...captured.request.headers, ...ready.credential_headers].map(({ name, value }) => [
              name,
              value,
            ]),
          ),
        },
        async (response) => {
          resolve({
            status: response.statusCode,
            headers: [{ name: "content-type", value: response.headers["content-type"] }],
            body: await buffer(response),
            trailers: response.rawTrailers.flatMap((name, index, values) =>
              index % 2 ? [] : [{ name, value: values[index + 1] }],
            ),
            response_complete: response.complete,
          });
        },
      );
      outgoing.on("error", reject);
      outgoing.end(captured.request.body);
    });
  }
  async function beginExchange(peer = metadata()) {
    /** @type {import("./openshell-grpc-sdk.ts").Grpc.ClientDuplexStream<unknown, unknown>} */
    const stream = clients.HttpInstallationExchange.Exchange(peer, {
      deadline: Date.now() + 5000,
    });
    const queued = [];
    const received = [];
    const waiting = [];
    let failure;
    stream.on("data", (message) => {
      received.push(message);
      const waiter = waiting.shift();
      if (waiter) {
        waiter.resolve(message);
      } else {
        queued.push(message);
      }
    });
    stream.on("error", (error) => {
      failure = error;
      for (const waiter of waiting.splice(0)) {
        waiter.reject(error);
      }
    });
    const next = () => {
      if (queued.length) {
        return Promise.resolve(queued.shift());
      }
      if (failure) {
        return Promise.reject(failure);
      }
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    };
    stream.on("end", () => {
      failure ??= new Error("Installation exchange ended without another message");
      for (const waiter of waiting.splice(0)) {
        waiter.reject(failure);
      }
    });
    const { challenge } = await next();
    return {
      stream,
      next,
      challenge,
      received,
      opening(captured, privateKey = exchangeKeys.privateKey, boundChallenge = challenge) {
        const encoded =
          definition["openshell.middleware.v1.HttpCredentialResolveRequest"].serialize(captured);
        return {
          open: {
            resolve_request: encoded,
            signature: sign(
              null,
              Buffer.concat([Buffer.from("openshell-exchange-v1\0"), boundChallenge, encoded]),
              privateKey,
            ),
          },
        };
      },
    };
  }
  // These are real bidirectional exchanges. In this fixture only, the test caller
  // owns the simulated downstream and gates synthetic provider access on the echoed custody.
  const exchangeByHandle = new Map();
  const exchangeByRequest = new WeakMap();
  async function resolve(captured, peer) {
    const exchange = await beginExchange(peer);
    exchange.stream.write(exchange.opening(captured));
    const { resolved } = await exchange.next();
    if (resolved.ready || resolved.ready_without_material) {
      const handle = (resolved.ready || resolved.ready_without_material).operation_handle.toString(
        "base64",
      );
      const entry = { captured, exchange };
      exchangeByHandle.set(handle, entry);
      exchange.stream.once("status", () => exchangeByHandle.delete(handle));
      exchangeByRequest.set(captured, exchange);
    }
    return resolved;
  }
  async function authorize(permit, { cancelAfterMs } = {}) {
    const handle = permit.operation_handle.toString("base64");
    const { captured, exchange } = exchangeByHandle.get(handle);
    const timer = cancelAfterMs && setTimeout(() => exchange.stream.cancel(), cancelAfterMs);
    try {
      exchange.stream.write({ authorize: permit });
      const { authorized } = await exchange.next();
      if (authorized.allowed) {
        assert.equal(authorized.allowed.no_material_required, permit.no_material_required === true);
        assert.deepEqual(authorized.allowed.response_custody, captured.response_custody);
        assert.deepEqual(
          authorized.allowed.credential_headers_sha256,
          permit.credential_headers_sha256,
        );
      }
      return authorized;
    } finally {
      clearTimeout(timer);
    }
  }
  // The supervisor's stream-progress frame; the reply is a lease or a refused stream.
  async function progress(captured, frame) {
    const exchange = exchangeByRequest.get(captured);
    exchange.stream.write({ progress: frame });
    try {
      const { lease } = await exchange.next();
      assert.ok(lease, "a progress frame is answered with a lease or a refusal");
      return lease;
    } catch (error) {
      if (error.code !== grpc.status.PERMISSION_DENIED) {
        throw error;
      }
      return { refused: true };
    }
  }
  async function protect(captured, response) {
    const exchange = exchangeByRequest.get(captured);
    exchange.stream.write({ response });
    try {
      const { response: result } = await exchange.next();
      assert.equal(result.response_complete, true);
      return result;
    } catch (error) {
      if (error.code !== grpc.status.PERMISSION_DENIED) {
        throw error;
      }
      assert.equal(
        exchange.received.filter((message) => message.response).length,
        0,
        "a refused complete response must release no response message, even a head",
      );
      return { blocked: true };
    }
  }
  return {
    ...app,
    fixtureKind: /** @type {const} */ ("deployed"),
    gatewayEffects,
    namespace,
    runtimeNamespace,
    modelProvider,
    refusalCode,
    secret,
    source,
    legacySource,
    providers,
    path,
    agent,
    revision,
    context,
    attachment,
    egress,
    installation,
    sandboxDriver: sandbox,
    installedDriver,
    gatewayClient: backend.client.clientForNamespace(runtimeNamespace.name),
    observed,
    clients,
    get authority() {
      return authority;
    },
    metadata,
    beginExchange,
    resolve,
    authorize,
    capture,
    permitRequest,
    send,
    progress,
    protect,
    async restartAuthority() {
      authority.forceShutdown();
      authority = createOpenShellEgressAuthority(identity, authorityController);
      await bindOpenShellEgressAuthority(authority, "127.0.0.1:" + authorityPort, cert, key);
      for (const [name, client] of Object.entries(clients)) {
        client.close();
        clients[name] = createAuthorityClient(name);
      }
    },
    providerRequests,
    provider,
    async exchangeResponse(response, request) {
      const captured = capture(request);
      const { ready } = await resolve(captured);
      assert.ok(ready, "authority resolved this operation");
      assert.ok((await authorize(permitRequest(captured, ready))).allowed);
      const before = providerRequests.length;
      providerResponse = response;
      const result = await protect(captured, await send(captured, ready));
      assert.equal(providerRequests.length, before + 1, "provider received the authorized request");
      return result;
    },
    async rotateSecret(value) {
      const result = await app.request(
        "PATCH",
        `/namespaces/${namespace.id}/secrets/${secret.id}`,
        {
          body: { value },
        },
      );
      assert.equal(result.status, 200, JSON.stringify(result.body));
    },
    setResponse(value) {
      providerResponse = value;
    },
    get secretReads() {
      return secretReads;
    },
    pauseNamespaceVerification() {
      const reached = Promise.withResolvers();
      const paused = Promise.withResolvers();
      beforeNamespaceResponse = () => {
        reached.resolve();
        return paused.promise;
      };
      return {
        reached: reached.promise,
        release() {
          beforeNamespaceResponse = undefined;
          paused.resolve();
        },
      };
    },
    pauseSecretReads() {
      const paused = Promise.withResolvers();
      secretReadBarrier = paused.promise;
      return () => {
        secretReadBarrier = undefined;
        paused.resolve();
      };
    },
    async revoke() {
      const result = await app.request(
        "DELETE",
        `/namespaces/${namespace.id}/iam/access-bindings/${grant.id}`,
      );
      assert.equal(result.status, 204, JSON.stringify(result.body));
    },
  };
}

/** @template {import("node:net").Server} [Provider=never]
 * @typedef {Awaited<ReturnType<typeof buildStaticEgressFixture<Provider>>>} StaticFixtureResult */
/** @template {import("node:net").Server} [Provider=never]
 * @typedef {NonNullable<Parameters<typeof buildStaticEgressFixture<Provider>>[1]>} StaticFixtureOptions */
/** @template {import("node:net").Server} [Provider=never]
 * @typedef {Omit<StaticFixtureOptions<Provider>, "admissionOnly" | "gatewayOnly" | "admitRevision">} ExecutionFixtureOptions */

/**
 * @template {import("node:net").Server} [Provider=never]
 * @overload
 * @param {import("node:test").TestContext} t
 * @param {ExecutionFixtureOptions<Provider> & {admitRevision: false}} options
 * @returns {Promise<Extract<StaticFixtureResult<Provider>, {fixtureKind: "undeployed"}>>}
 */
/**
 * @template {import("node:net").Server} [Provider=never]
 * @overload
 * @param {import("node:test").TestContext} t
 * @param {ExecutionFixtureOptions<Provider> & {admitRevision?: true}} [options]
 * @returns {Promise<Extract<StaticFixtureResult<Provider>, {fixtureKind: "deployed"}>>}
 */
/**
 * @template {import("node:net").Server} [Provider=never]
 * @overload
 * @param {import("node:test").TestContext} t
 * @param {ExecutionFixtureOptions<Provider> & {admitRevision?: boolean}} [options]
 * @returns {Promise<Exclude<StaticFixtureResult<Provider>, {fixtureKind: "admission"}>>}
 */
/**
 * @template {import("node:net").Server} [Provider=never]
 * @param {import("node:test").TestContext} t
 * @param {ExecutionFixtureOptions<Provider> & {admitRevision?: boolean}} [options]
 */
export async function staticEgressFixture(t, options) {
  const fixture = await buildStaticEgressFixture(t, options);
  if (fixture.fixtureKind === "admission") {
    throw new Error("Expected a static egress fixture.");
  }
  return fixture;
}

/**
 * @param {import("node:test").TestContext} t
 * @param {Pick<StaticFixtureOptions, "gatewayOnly" | "includeLegacy" | "now">} [options]
 */
export async function staticEgressAdmissionFixture(t, options) {
  const fixture = await buildStaticEgressFixture(t, { ...options, admissionOnly: true });
  if (fixture.fixtureKind !== "admission") {
    throw new Error("Expected an admission fixture.");
  }
  return fixture;
}

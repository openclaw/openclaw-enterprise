import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { createCredentialProxyInstallationConfiguration } from "./installation-driver-configuration.ts";
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
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
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
import { selfSigned } from "./certificates.ts";
import { listen } from "./listen.ts";
import {
  createExchangeClients,
  createExchangeOrigin,
  createStaticEgressExchange,
} from "./static-egress-exchange.ts";
import { Check } from "typebox/value";
import { NamespaceSchema } from "../../packages/contracts/src/api/resources.ts";
import { temporaryDirectory } from "./temporary-directory.mjs";

export { requestId } from "./static-egress-request-id.ts";
export { supervisorBearer, wireTime } from "./static-egress-exchange.ts";
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

export const unary = (client, method, request, metadata, timeoutMs = 5000) =>
  new Promise((resolve, reject) =>
    client[method](
      request,
      metadata ?? new grpc.Metadata(),
      { deadline: Date.now() + timeoutMs },
      (error, result) => (error ? reject(error) : resolve(result)),
    ),
  );
/** Real app/auth/IAM/controller/Drivers. Storage and installed runtime observations are wire fixtures,
 * not a Kubernetes API server or an OpenShell supervisor. No authorization/provider logic is mocked.
 * @template {import("node:net").Server} [Provider=never]
 */
async function buildStaticEgressFixture(
  t,
  {
    appFactory = /** @type {(t: import("node:test").TestContext, options?: Parameters<typeof createConsoleAppFixture>[1], transportDatabaseUrl?: string) => Promise<Awaited<ReturnType<typeof createConsoleAppFixture>> | Awaited<ReturnType<typeof import("./postgres-egress-app.mjs").postgresApp>>>} */ (
      createConsoleAppFixture
    ),
    transportDatabaseUrl = /** @type {string | undefined} */ (undefined),
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
    policyVersion: 1,
    activePolicyVersion: 1,
    policyStatus: 2,
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
          version: observed.policyVersion,
          status: observed.policyStatus,
          policy: observed.policy,
          policy_hash: observed.policyHash,
        },
        loaded_enforcement:
          observed.evidence?.policy_hash === observed.policyHash ? observed.evidence : undefined,
        loaded_policy_observation: observed.observation
          ? { ...observed.observation, enforcement: observed.evidence }
          : undefined,
        active_version: observed.activePolicyVersion,
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
        integrationMode: "legacy",
        gateway: {},
        kubernetes: {
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
  const origin = await createExchangeOrigin(t, { key, cert }, providerServer);
  const { providerPort, providerRequests, setResponse } = origin;
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
  const gatewayMethods = /** @type {const} */ (["registerSource", "updateSource", "removeSource"]);
  /** @type {(typeof gatewayMethods)[number][]} */
  const gatewayEffects = [];
  for (const method of gatewayMethods) {
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
  const app = await appFactory(
    t,
    {
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
    },
    transportDatabaseUrl,
  );
  await app.bootstrap();
  if (!protectedSourceOnly) {
    app.controller.registerDriver(catalog);
    app.controller.selectDriver(catalog.capability, catalog.id);
  }
  app.controller.registerDriver(installedDriver);
  app.controller.selectDriver("sandbox", sandbox.id);
  const createdNamespace = await app.createNamespace(`egress-${randomUUID().slice(0, 8)}`);
  assert.ok(Check(NamespaceSchema, createdNamespace), "Expected a valid provisioned Namespace");
  namespace = createdNamespace;
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
      placement,
      countStoredSecrets: () => objects.size,
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
  assert.ok(revision?.egressPlan, "deployment must admit the consumed protected plan");
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
  const {
    clients,
    reconnect,
    transport: exchangeTransport,
  } = createExchangeClients(t, authorityPort, cert);
  const exchange = createStaticEgressExchange({
    cert,
    controller: app.controller,
    exchangeKeys,
    getSecretReads: () => secretReads,
    installation,
    namespace,
    now,
    origin,
    sandboxId,
    supervisorKey: keys.privateKey,
    transport: exchangeTransport,
  });
  return {
    ...app,
    fixtureKind: /** @type {const} */ ("deployed"),
    gatewayEffects,
    namespace,
    runtimeNamespace,
    modelProvider,
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
    ...exchange,
    exchange,
    async restartAuthority() {
      authority.forceShutdown();
      authority = createOpenShellEgressAuthority(identity, authorityController);
      await bindOpenShellEgressAuthority(authority, "127.0.0.1:" + authorityPort, cert, key);
      reconnect();
    },
    setResponse,
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
 * @template {import("node:net").Server} [Provider=never]
 * @param {import("node:test").TestContext} t
 * @param {{now?: () => Date, providerServer?: (tls: import("node:tls").TlsOptions, handle: import("node:http").RequestListener) => Provider, credentialProxyCapacity?: import("../../packages/occ/src/credential-proxy.ts").CredentialProxyCapacity}} [options]
 */
export async function staticEgressWireFixture(t, options) {
  const fixture = await buildStaticEgressFixture(t, options);
  if (fixture.fixtureKind !== "deployed") {
    throw new Error("Expected a deployed installation exchange fixture.");
  }
  return fixture.exchange;
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

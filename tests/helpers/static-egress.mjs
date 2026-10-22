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
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
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
export function requestId(createdAt = Date.now()) {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(createdAt, 0, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export const unary = (client, method, request, metadata, timeoutMs = 5000) =>
  new Promise((resolve, reject) =>
    client[method](
      request,
      metadata ?? new grpc.Metadata(),
      { deadline: Date.now() + timeoutMs },
      (error, result) => (error ? reject(error) : resolve(result)),
    ),
  );
async function listen(t, server) {
  const port = await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return port;
}

export function supervisorBearer(claims, privateKey) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "EdDSA", typ: "openshell-ext+jwt", kid: "fixture-key" });
  const signed = header + "." + encode(claims);
  return `Bearer ${signed}.${sign(null, Buffer.from(signed), privateKey).toString("base64url")}`;
}

/** Real app/auth/IAM/controller/Drivers. Storage and installed runtime observations are wire fixtures,
 * not a Kubernetes API server or an OpenShell supervisor. No authorization/provider logic is mocked. */
export async function staticEgressFixture(
  t,
  {
    appFactory = createConsoleAppFixture,
    driverConfigurations = /** @type {readonly import("../../packages/occ/src/index.ts").DriverConfigurationRegistration[]} */ ([]),
    includeLegacy = false,
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
    providerServer = createHttpsServer,
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "oce-egress-wire-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyPath = join(directory, "tls.key");
  const certPath = join(directory, "tls.crt");
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,DNS:provider.example.test,IP:127.0.0.1",
    ],
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr);
  // Only ephemeral test-generated material is read; no operator credential files are involved.
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
  const objects = new Map();
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

  const Gateway = grpc.loadPackageDefinition(loadGatewayDefinition()).openshell.v1.OpenShell;
  const gateway = new grpc.Server();
  const observed = {
    available: true,
    sandbox: undefined,
    policy: undefined,
    deleted: [],
    workspaceVisible: true,
  };
  // OpenShell reports negotiated capabilities in lexical order, including the base contract.
  const gatewayCapabilities = ["openshell.supervisor-middleware.contract", ...capabilities].sort();
  const profiles = new Map();
  const providers = new Map();
  gateway.addService(Gateway.service, {
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
      callback(
        provider ? null : { code: grpc.status.NOT_FOUND },
        provider ? { provider } : undefined,
      );
    },
    GetGatewayInfo(_call, callback) {
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
          metadata: { name: call.request.name },
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
  const sandbox = new OpenShellSandboxDriver(
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
    preparedTokens.register({
      provider: preparedGitHubProviderRef,
      sourceFromRoute: preparedGitHubSourceFromRoute,
      issuerInput: "private_key",
      issuerAuthority: "fixture-github-metadata",
      admission(config) {
        return { origin: owner.apiOrigin, grant: githubMetadataGrant(config), schemaVersion: 2 };
      },
      configure: (...args) => owner.configure(...args),
      readWarm: (...args) => owner.readWarm(...args),
      ready: (...args) => owner.ready(...args),
      withdraw: (...args) => owner.withdraw(...args),
    });
  }
  const egress = new OpenShellCredentialProxyDriver(egressOptions, {
    id: proxyDriverId,
    preparedProviders: preparedProvider
      ? [preparedProvider]
      : owner
        ? [githubMetadataProvider]
        : [],
    backend,
    sandbox,
  });
  const catalog = new OpenShellCredentialGatewayDriver(
    { binaries: ["/usr/bin/model-client"] },
    { id: "openshell-credentials", backend },
  );
  const placement = createTestKubernetesComputeDriver("placement", {
    authentication: { mode: "kubeconfig", kubeconfigPath, context: "fixture" },
  });
  const app = await appFactory(t, {
    now,
    provisionedPeople: [],
    preparedTokens,
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
    computeDriver: {
      ...createDevelopmentComputeDriver(),
      // Schema/protocol fixture only: no workload is released by this Compute.
      validateExecutionAdmission: assertExecutionAdmission,
      async resolveSandboxNamespace(value) {
        return physicalPlacement ? placement.resolveSandboxNamespace(value) : value;
      },
    },
  });
  await app.bootstrap();
  if (!protectedSourceOnly) {
    app.controller.registerDriver(catalog);
    app.controller.selectDriver(catalog.capability, catalog.id);
  }
  const installedDriver = new InstalledDriver(
    { id: sandbox.id, implementation: sandbox.implementation, configuration: egressOptions },
    { capabilities: { sandbox, credential_proxy: egress } },
    { sandbox: sandbox.id, credential_proxy: egress.id },
  );
  app.controller.registerDriver(installedDriver);
  app.controller.selectDriver("sandbox", sandbox.id);
  namespace = await app.createNamespace(`egress-${randomUUID().slice(0, 8)}`, { ready: true });
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
  const providerRequests = [];
  let providerResponse = { status: 200, body: { output: "fixture answer" } };
  const provider = providerServer({ key, cert }, async (request, response) => {
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
  let legacySource;
  if (includeLegacy) {
    legacySource = await post("credential-sources", {
      name: "approved-copy",
      type: "openai",
      secrets: { api_key: secret.ref },
    });
  }
  app.controller.selectDriver("credential_proxy", egress.id);
  let source = protectedSourceOnly
    ? undefined
    : await post("credential-sources", {
        name: "inference",
        type: "openai",
        config: { base_url: `https://provider.example.test:${providerPort}/v1` },
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
    return { ...app, namespace, agent, source, grant };
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
  const refusalCode = (name) => {
    const entry = definition["openshell.middleware.v1.HttpCredentialRefusalCode"].type.value.find(
      (value) => value.name === `HTTP_CREDENTIAL_REFUSAL_CODE_${name}`,
    );
    assert.ok(entry, `Unknown HTTP credential refusal code: ${name}`);
    return entry.number;
  };
  const services = grpc.loadPackageDefinition(definition).openshell.middleware.v1;
  const clients = Object.fromEntries(
    [
      "HttpCredentialAccess",
      "HttpResponsePreReturn",
      "SupervisorMiddleware",
      "HttpInstallationExchange",
    ].map((name) => [
      name,
      new services[name](`127.0.0.1:${authorityPort}`, grpc.credentials.createSsl(cert)),
    ]),
  );
  t.after(() => {
    for (const client of Object.values(clients)) {
      client.close();
    }
  });
  const metadata = (overrides = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const token = supervisorBearer(
      {
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
        ...overrides,
      },
      keys.privateKey,
    );
    const result = new grpc.Metadata();
    result.set("authorization", token);
    return result;
  };
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
    namespace,
    runtimeNamespace,
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
        clients[name] = new services[name](
          "127.0.0.1:" + authorityPort,
          grpc.credentials.createSsl(cert),
        );
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

/** Explicit trusted acceptance profile for dispatch tests only. The captured owner
 * holds the actual sender and reply recipient; no bearer or header establishes custody. */
export async function syntheticDispatchFixture(t, receipts) {
  const { createServer, connect } = await import("node:net");
  const { once } = await import("node:events");
  const { CredentialProxy } = await import("../../packages/occ/src/credential-proxy.ts");
  const { openAiStaticProvider } =
    await import("../../apps/controller/src/drivers/egress-proxy/openai-provider.ts");
  const ref = () => ({ id: randomUUID(), generation: 1 });
  const now = Date.now();
  const deadlineAt = new Date(now + 25_000).toISOString();
  const execution = Object.fromEntries(
    [
      "installationId",
      "namespaceId",
      "agentId",
      "servicePrincipalId",
      "revisionId",
      "executionId",
    ].map((key) => [key, randomUUID()]),
  );
  const sender = ref();
  const peer = { sender, sandboxId: randomUUID(), instanceId: randomUUID(), expiresAt: deadlineAt };
  const source = {
    key: {
      installationId: execution.installationId,
      namespaceId: execution.namespaceId,
      source: ref(),
      backend: ref(),
      provider: ref(),
    },
    adoption: "live",
    materialRefId: randomUUID(),
    secret: { kind: "secret", namespaceId: execution.namespaceId, id: randomUUID() },
    secretDriver: ref(),
  };
  const route = {
    route: ref(),
    binding: {
      binding: ref(),
      execution,
      source: source.key,
      grant: { kind: "inference", models: ["fixture-model"], providerTools: "none" },
      grantHash: "synthetic",
      isolationId: randomUUID(),
    },
    origin: "https://provider.example.test",
    path: "/v1/responses",
    method: "POST",
    operationPolicy: ref(),
    responsePolicy: ref(),
    deadlineMs: 30_000,
  };
  const policyHash = "fb".repeat(32);
  const installation = {
    sender,
    sandboxId: peer.sandboxId,
    installedAt: new Date(now).toISOString(),
    enforcement: {
      instanceId: peer.instanceId,
      configurationId: randomUUID(),
      policyHash,
      authorityScope: "execution",
    },
    plan: {
      ...ref(),
      execution,
      sandboxDriverId: "synthetic",
      egressDriverId: sender.id,
      routes: [route],
    },
  };
  const request = {
    id: requestId(now),
    method: "POST",
    url: route.origin + route.path,
    verifiedExecutionPolicyHash: policyHash,
    headers: [["content-type", "application/json"]],
    body: Buffer.from(JSON.stringify({ model: "fixture-model", input: "hello", store: false })),
    deadlineAt,
  };
  const custody = { id: randomUUID(), reply: { id: randomUUID(), chunks: [] } };
  const association = {
    execution,
    installation: {
      sandboxId: peer.sandboxId,
      ...installation.enforcement,
      plan: { id: installation.plan.id, generation: installation.plan.generation },
    },
    exchangeId: randomUUID(),
    responseId: custody.reply.id,
    custodyId: custody.id,
  };
  let reads = 0;
  let arrivals = 0;
  let permits = 0;
  let current = true;
  let clock = now;
  let ready;
  // Count the first bytes on each connection before parsing any application data.
  const origin = createServer((socket) =>
    socket.once("data", () => {
      arrivals++;
      socket.end("synthetic response");
    }),
  );
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  t.after(() => new Promise((resolve) => origin.close(resolve)));
  const exchangeOwner = {
    verify: async () => peer,
    capture(use) {
      return current && use.request.id === request.id ? association : undefined;
    },
    owns(value, use) {
      return (
        current &&
        JSON.stringify(value) === JSON.stringify(association) &&
        use.request.id === request.id &&
        Buffer.from(use.request.body).equals(request.body)
      );
    },
  };
  const ports = {
    exchangeOwner,
    receipts,
    now: () => clock,
    installation: async () => installation,
    provider: () => openAiStaticProvider,
    // Policy and Secret dependencies are synthetic; dispatch, persistence and sockets are real.
    check: async () => source,
    read: async () => {
      reads++;
      return {
        value: "synthetic-material",
        version: "N",
        materialId: "synthetic-material-id",
        authoritativeObservedAt: new Date(now).toISOString(),
      };
    },
  };
  let forwarder = new CredentialProxy(ports);
  const authorizeSend = (signal = new AbortController().signal) => {
    assert.equal(ready.kind, "ready");
    return forwarder.authorizeSend(
      "synthetic-peer",
      peer.sandboxId,
      request.id,
      ready.handle,
      ready.evidence,
      ready.injectionDigest,
      request.deadlineAt,
      signal,
    );
  };
  return {
    startedAt: new Date(now).toISOString(),
    get reads() {
      return reads;
    },
    request,
    association,
    sender,
    ports,
    get arrivals() {
      return arrivals;
    },
    get permits() {
      return permits;
    },
    advance(ms) {
      clock += ms;
    },
    replaceCustody() {
      current = false;
    },
    restart() {
      forwarder = new CredentialProxy(ports);
    },
    async resolve() {
      ready = await forwarder.resolve(
        "synthetic-peer",
        peer.sandboxId,
        request,
        new AbortController().signal,
      );
      return ready;
    },
    authorizeSend,
    async dispatch(signal) {
      const decision = await authorizeSend(signal);
      if (decision.kind !== "allow") {
        return decision;
      }
      permits++;
      // The real sender retains this accepted operation and destination. A permit for
      // any other operation/custody or an expired permit cannot reach the socket.
      assert.deepEqual(decision.authorization.association, association);
      assert.equal(decision.injectionDigest, ready.injectionDigest);
      assert.equal(
        decision.authorization.requestDigest,
        createHash("sha256")
          .update(JSON.stringify({ ...request, body: request.body.toString("base64") }))
          .digest("hex"),
      );
      assert.ok(current && clock < Date.parse(decision.sendStartBy));
      const socket = connect(origin.address().port, "127.0.0.1");
      socket.on("data", (bytes) => custody.reply.chunks.push(bytes));
      await once(socket, "connect");
      assert.ok(current && clock < Date.parse(decision.sendStartBy));
      socket.end(request.body);
      await once(socket, "close");
      assert.equal(Buffer.concat(custody.reply.chunks).toString(), "synthetic response");
      return decision;
    },
    attempt() {
      return {
        sender,
        instanceId: peer.instanceId,
        useId: request.id,
        attemptId: request.id,
        material: ready.evidence,
        deadlineAt,
      };
    },
  };
}

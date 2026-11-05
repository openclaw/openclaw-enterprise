import { createCredentialProxyInstallationConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { loadInstallationFile } from "../helpers/installation-file.mjs";
import {
  OpenShellGateway,
  openShellProviderName,
  openShellWorkspaceName,
} from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import {
  workspaceSetupFixture,
  type FixtureDriver,
} from "../helpers/kubernetes-workspace-setup.ts";
import { tenant } from "../helpers/kubernetes-routed-scenarios.mjs";
import type {
  AgentRevision,
  ComputeRevisionContext,
  CredentialSource,
} from "../../packages/contracts/src/index.ts";
import type {
  OpenShellGatewayClient,
  OpenShellProviderProfile,
  OpenShellProviderResponse,
  OpenShellStoredProviderProfile,
  OpenShellSandboxResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Configuration = ReturnType<typeof createCredentialProxyInstallationConfiguration> & {
  backend: [
    {
      drivers: { sandbox: string; credential_gateway: string; credential_proxy?: string };
      configuration: Record<string, unknown>;
    },
  ];
  drivers: {
    credential_proxy?: unknown;
    compute: {
      configuration: Record<string, unknown> & {
        images: unknown;
        network: Record<string, unknown>;
      };
    };
  };
};
test("startup composes both OpenShell members from one Backend for static source preparation", async (t) => {
  const fixture = workspaceSetupFixture(false);
  const { state, objects, namespace } = fixture;
  const revision = fixture.revision as unknown as Mutable<AgentRevision>;
  const context = fixture.context as Mutable<ComputeRevisionContext>;
  const configuration = createCredentialProxyInstallationConfiguration() as Configuration;
  delete configuration.drivers.credential_proxy;
  delete configuration.backend[0].drivers.credential_proxy;
  configuration.backend[0].configuration = {
    serviceName: "openshell-gateway",
    port: 50051,
    insecureTransport: "network-policy",
  };
  configuration.drivers.compute.id = fixture.driver.id;
  configuration.drivers.compute.configuration = {
    ...fixture.driver.options,
    images: configuration.drivers.compute.configuration.images,
  };
  configuration.drivers.compute.configuration.network.providerHarness = {
    namespace: "openshell",
    podLabels: { app: "openshell-gateway" },
    address: "10.43.0.50",
    port: 8080,
  };
  // This already initialized Agent exercises attachment lifecycle, not file delivery.
  delete context.workspaceSetup;
  const source: CredentialSource = {
    id: "cs_00000000-0000-4000-8000-000000000001",
    namespaceId: tenant.id,
    name: "Static OpenAI",
    type: "openai",
    config: {},
    secrets: {},
    ownerCapability: "credential_gateway",
    driverId: "openshell-credentials",
    state: "ready",
    createdAt: tenant.createdAt,
  };
  const providerName = openShellProviderName(source.id);
  const calls: unknown[][] = [];
  const writes: (
    | ["createProvider", unknown]
    | ["importProviderProfile" | "updateProviderProfile", string, OpenShellProviderProfile]
  )[] = [];
  const profiles = new Map<string, OpenShellStoredProviderProfile>();
  let provider: OpenShellProviderResponse = {
    name: providerName,
    type: providerName,
    labels: {
      "app.kubernetes.io/managed-by": "openclaw-enterprise",
      "openclaw.dev/credential-source-id": source.id,
    },
    config: {},
    resourceVersion: "1",
  };
  const runtimeProviders = new Map<string, OpenShellProviderResponse>();
  const observed: { sandbox?: OpenShellSandboxResponse } = {};
  let revoked = false;
  // Model only Backend storage and transport responses; the real Drivers choose,
  // authorize, reconcile, and withdraw the attachment. No provider is contacted.
  const unexpected = (): never => {
    throw new Error("unexpected Backend operation");
  };
  const client: OpenShellGatewayClient = {
    health: unexpected,
    getWorkspace: unexpected,
    createWorkspace: unexpected,
    deleteWorkspace: unexpected,
    getServiceUrl: unexpected,
    deleteService: unexpected,
    deleteSandbox: unexpected,
    execSandbox: unexpected,
    getServiceDocument: unexpected,
    postServiceDocument: unexpected,
    listProviderProfiles: unexpected,
    deleteProviderProfile: unexpected,
    listProviders: unexpected,
    updateProviderCredentials: unexpected,
    updateProviderConfig: unexpected,
    getProviderCredential: unexpected,
    configureProviderRefresh: unexpected,
    rotateProviderCredential: unexpected,
    getProviderRefreshStatus: unexpected,
    deleteProviderRefresh: unexpected,
    getSandboxLogs: unexpected,
    close: unexpected,
    async getProvider(workspace, name) {
      calls.push(["getProvider", workspace, name]);
      return name === providerName ? provider : runtimeProviders.get(name);
    },
    async getProviderProfile(workspace, id) {
      return profiles.get(id);
    },
    async importProviderProfile(workspace, profile) {
      writes.push(["importProviderProfile", workspace, structuredClone(profile)]);
      profiles.set(profile.id, { ...profile, resourceVersion: "1" });
    },
    async updateProviderProfile(workspace, profile) {
      writes.push(["updateProviderProfile", workspace, structuredClone(profile)]);
      profiles.set(profile.id, { ...profile, resourceVersion: "2" });
    },
    async createProvider(request) {
      writes.push(["createProvider", structuredClone(request)]);
      const value = { ...request, config: request.config ?? {}, resourceVersion: "1" };
      runtimeProviders.set(request.name, value);
      return value;
    },
    async deleteProvider() {
      throw new Error("withdrawal must not delete source providers");
    },
    async getSandbox() {
      return observed.sandbox;
    },
    async createSandbox(request) {
      calls.push(["createSandbox", structuredClone(request)]);
      observed.sandbox = {
        ...request,
        id: "sandbox-1",
        phase: "SANDBOX_PHASE_READY",
        serviceUrls: { "": "http://10.43.0.50:8080" },
      };
      return observed.sandbox;
    },
    async getService() {
      assert.ok(observed.sandbox);
      const environment = observed.sandbox.spec?.environment;
      assert.ok(environment && typeof environment === "object" && "APP_SERVER_PORT" in environment);
      return {
        sandbox: observed.sandbox.name,
        name: "",
        url: "http://10.43.0.50:8080",
        advertisedUrl: "http://10.43.0.50:8080",
        targetPort: Number(environment.APP_SERVER_PORT),
        authorizationMode: "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH",
      };
    },
    async serviceWebSocketHandshake() {
      return true;
    },
    async getSandboxProviderStatus(workspace, name, provider, signal, receipt) {
      calls.push(["status", workspace, name, provider, receipt]);
      return {
        state: revoked ? "PROVIDER_READINESS_STATE_REVOKED" : "PROVIDER_READINESS_STATE_READY",
      };
    },
    async detachSandboxProvider(workspace, name, provider) {
      calls.push(["detach", workspace, name, provider]);
      revoked = true;
      return { receiptId: "withdrawal-1" };
    },
  };
  const loaderOptions = {
    environment: {},
    createOpenShellBackend: () => ({
      id: "openshell",
      drivers: configuration.backend[0].drivers,
      client: new OpenShellGateway({ serviceName: "openshell-gateway" }, { gatewayClient: client }),
    }),
  };
  const loaded = await loadInstallationFile(t, configuration, loaderOptions);
  assert.ok(loaded);
  const driver = loaded.computeDriver as unknown as FixtureDriver;
  const gateway = loaded.credentialGatewayDriver;
  assert.ok(gateway instanceof OpenShellCredentialGatewayDriver);
  assert.ok(loaded.sandboxDriver instanceof OpenShellSandboxDriver);
  // Reuse the Kubernetes and node-enrollment boundary of the maintained workflow.
  const clients = await fixture.driver.apiClients;
  const { KubernetesObjectApi } = createRequire(
    new URL("../../apps/controller/package.json", import.meta.url),
  )("@kubernetes/client-node");
  clients.objects = Object.assign(Object.create(KubernetesObjectApi.prototype), clients.objects);
  const listPods = clients.core.listNamespacedPod;
  clients.core.listNamespacedPod = async (request) => {
    if (observed.sandbox && request.labelSelector?.includes("openclaw.dev/workload-role=agent")) {
      return {
        items: [
          {
            metadata: { name: observed.sandbox.name, namespace, labels: observed.sandbox.labels },
            status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
          },
        ],
      };
    }
    return listPods(request);
  };
  driver.apiClients = Promise.resolve(clients);
  driver.nodeEnrollment = {
    ...fixture.driver.nodeEnrollment,
    async createSetup() {
      const expiresAtMs = Date.now() + 60000;
      const setupCode = Buffer.from(
        JSON.stringify({
          url: "wss://agents.example.test/node",
          bootstrapToken: "fixture-node-bootstrap",
          expiresAtMs,
          tlsFingerprint: "ab".repeat(32),
        }),
      ).toString("base64url");
      return { setupId: "setup-1", setupCode, expiresAtMs };
    },
  };
  revision.id = "rev_00000000-0000-4000-8000-000000000003";
  revision.compute = { id: driver.id, implementation: driver.implementation };
  revision.sandboxDriverId = loaded.sandboxDriver.id;
  const agents = revision.configuration.agents;
  assert.ok(agents && typeof agents === "object" && !Array.isArray(agents) && "defaults" in agents);
  const defaults = agents.defaults;
  assert.ok(defaults && typeof defaults === "object");
  Object.assign(defaults, { workspace: "/sandbox/enterprise" });
  revision.harnessAuth = {
    method: "credential_source",
    sourceId: source.id,
    credentialGatewayId: gateway.id,
    sourceType: "openai",
    loginMode: "api_key",
  };
  Object.assign(context, { harnessAuth: { ...revision.harnessAuth, source } });
  objects.delete(`Secret:${namespace}:occ-model-key`);
  state.ready = true;
  const legacy: string[] = [];
  for (const method of ["attachForRevision", "attachmentStatus", "withdraw"] as const) {
    gateway[method] = async () => {
      legacy.push(method);
      throw new Error(`unexpected legacy Gateway callback: ${method}`);
    };
  }
  assert.equal((await driver.prepareRevision(revision, context)).ready, true);
  assert.equal((await driver.prepareRevision(revision, context)).ready, true);
  const workspace = openShellWorkspaceName({ ...tenant, status: "ready", name: namespace });
  assert.ok(observed.sandbox, "preparation creates the real Sandbox request");
  const sandbox = observed.sandbox;
  const providers = sandbox.spec?.providers;
  assert.ok(Array.isArray(providers));
  assert.deepEqual(
    providers.filter((name: unknown) => typeof name === "string" && name.startsWith("oce-cs-")),
    [providerName],
  );
  assert.ok(
    calls.some(
      (call) => call[0] === "getProvider" && call[1] === workspace && call[2] === providerName,
    ),
  );
  assert.ok(
    writes.some(
      ([method, target, profile]) =>
        method === "importProviderProfile" && target === workspace && profile?.id === providerName,
    ),
  );
  assert.ok(
    calls.some(
      (call) =>
        call[0] === "status" &&
        call[1] === workspace &&
        call[2] === sandbox.name &&
        call[3] === providerName,
    ),
  );
  assert.deepEqual(
    await driver.withdrawCredentialSource(revision, source, AbortSignal.timeout(2000)),
    { sourceId: source.id, state: "revoked" },
  );
  assert.deepEqual(
    calls.filter(([method]) => method === "detach"),
    [["detach", workspace, sandbox.name, providerName]],
  );
  assert.deepEqual(calls.at(-1), ["status", workspace, sandbox.name, providerName, "withdrawal-1"]);
  assert.deepEqual(legacy, []);

  await t.test(
    "multi-source admission withdraws the Harness source through the public Gateway",
    async () => {
      // Withdrawal receives one live source even when admission recorded more. The
      // revision's full admission must keep this operation on the public Gateway.
      const mixedRevision = {
        ...revision,
        credentialSources: [
          {
            sourceId: "cs_00000000-0000-4000-8000-000000000002",
            credentialGatewayId: gateway.id,
            sourceType: "bearer-token",
          },
        ],
      };
      const withdrawals: Parameters<typeof gateway.withdraw>[0][] = [];
      const withdraw = gateway.withdraw;
      const before = calls.length;
      // Observe dispatch at the public contract without forwarding to its shared
      // implementation: a direct Backend detach would otherwise look identical.
      gateway.withdraw = async (request) => {
        withdrawals.push(request);
        return { sourceId: request.sourceId, state: "revoked" };
      };
      try {
        await driver.withdrawCredentialSource(mixedRevision, source, AbortSignal.timeout(2000));
        assert.deepEqual(
          {
            publicWithdrawals: withdrawals.length,
            directDetaches: calls.slice(before).filter(([method]) => method === "detach").length,
          },
          { publicWithdrawals: 1, directDetaches: 0 },
        );
        assert.ok(withdrawals[0]);
        assert.equal(withdrawals[0].sourceId, source.id);
        assert.equal(withdrawals[0].revision, mixedRevision);
        assert.equal(withdrawals[0].namespace.id, source.namespaceId);
        assert.deepEqual(withdrawals[0].sandbox, {
          namespaceName: namespace,
          resourceName: sandbox.name,
          agentId: mixedRevision.agentId,
          revisionId: mixedRevision.id,
        });
        assert.deepEqual(legacy, []);
      } finally {
        gateway.withdraw = withdraw;
      }
    },
  );

  await t.test(
    "changed login mode refuses before attachment and stale Gateway refuses before catalog",
    async () => {
      const listSourceTypes = gateway.listSourceTypes;
      const catalog = await listSourceTypes.call(gateway, { signal: AbortSignal.timeout(2000) });
      let reads = 0;
      gateway.listSourceTypes = async () => {
        reads++;
        return catalog.map((entry) =>
          entry.type === "openai"
            ? { ...entry, harnessAuth: { modelProvider: "openai", loginMode: "chatgptAuthTokens" } }
            : entry,
        );
      };
      const before = writes.length;
      const observations = calls.length;
      const refusal = (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.constructor.name, "ConfigurationFailure");
        assert.equal(
          error.message,
          "Credential-source Harness authentication requires paired Drivers and a matching supported OpenAI login mode.",
        );
        return true;
      };
      try {
        await assert.rejects(driver.prepareRevision(revision, context), refusal);
        assert.equal(reads, 1);
        Object.assign(gateway, { id: "replacement-gateway" });
        await assert.rejects(driver.prepareRevision(revision, context), refusal);
        assert.equal(reads, 1);
        assert.equal(writes.length, before);
        assert.equal(calls.length, observations);
        assert.deepEqual(legacy, []);
      } finally {
        Object.assign(gateway, { id: source.driverId });
        gateway.listSourceTypes = listSourceTypes;
      }
    },
  );
  await t.test(
    "selected handler refuses a provider without source ownership without fallback",
    async () => {
      // A same-name foreign provider must be rejected by the selected real handler.
      provider = { ...provider, labels: {} };
      const before = writes.length;
      const observations = calls.length;
      await assert.rejects(driver.prepareRevision(revision, context), {
        message: "The OpenShell provider for a bound credential source is unavailable.",
      });
      assert.deepEqual(calls.slice(observations), [["getProvider", workspace, providerName]]);
      assert.equal(writes.length, before);
      assert.deepEqual(legacy, []);
    },
  );
});

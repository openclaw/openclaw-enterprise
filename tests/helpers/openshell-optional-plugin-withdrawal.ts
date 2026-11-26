import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";

import pg from "pg";
import { installSelectedSandboxDrivers } from "../../apps/controller/src/composition/sandbox-drivers.ts";
import { installTokenServiceDriver } from "../../apps/controller/src/composition/token-service.ts";
import {
  credentialSourceDeliveryBinding,
  installationControllerOptions,
} from "../../apps/controller/src/composition/installation-config.ts";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { OCCPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import {
  managedCliInstalls,
  managedMcpInstalls,
} from "../../apps/controller/src/drivers/plugin/managed-catalog.ts";
import { openShellCredentialProviderName } from "../../apps/controller/src/drivers/sandbox/openshell-credential-policy.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { normalizeOpenShellModelId } from "../../scripts/ci/openshell-model-inputs.ts";
import { createEnvoyWorkspaceGatewayPlan } from "./envoy-workspace-gateway.mjs";
import { createHarnessConfiguration, nativeAdminGatewayAuth } from "./harness-configuration.mjs";
import { loadInstallationFile } from "./installation-file.ts";
import {
  createOpenShellTokenServiceInstallationConfiguration,
  createOpenShellKubernetesFixture,
  waitForOpenShellRevisionActivation,
} from "./openshell-kubernetes-real.mjs";
import { createPostgresAgentApp } from "./postgres-agent-app.mjs";
import { databaseUrl } from "./postgres-database.mjs";
import { temporaryDirectory } from "./temporary-directory.ts";
import { waitFor } from "./wait-for.ts";
import { startWorkspaceGatewayHostRelay } from "./workspace-gateway-host-relay.ts";

function networkEntries(policy: unknown) {
  return Object.values(asRecord(asRecord(policy)?.network_policies) ?? {}).flatMap((value) => {
    const rule = asRecord(value);
    return Array.isArray(rule?.endpoints)
      ? rule.endpoints
          .map(asRecord)
          .filter((entry) => entry !== undefined)
          .map((endpoint) => ({ binaries: rule.binaries, endpoint }))
      : [];
  });
}

function endpoints(policy: unknown) {
  return networkEntries(policy).map(({ endpoint }) => endpoint);
}

export async function verifyOpenShellOptionalPluginWithdrawal(t: TestContext): Promise<void> {
  assert.ok(
    databaseUrl,
    "The native withdrawal scenario requires a migrated disposable PostgreSQL database.",
  );
  const kubeconfigPath = process.env.OCC_TEST_KUBERNETES_KUBECONFIG;
  const kubernetesContext = process.env.OCC_TEST_KUBERNETES_CONTEXT;
  const gatewayImage = process.env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE;
  const codexImage = process.env.OCC_TEST_KUBERNETES_AGENT_IMAGE;
  assert.ok(kubeconfigPath && kubernetesContext && gatewayImage && codexImage);
  const fixture = createOpenShellKubernetesFixture({
    kubeconfigPath,
    kubernetesContext,
    gatewayImage,
    codexImage,
    databaseUrl,
    openShellGatewayImage: process.env.OCC_TEST_OPENSHELL_GATEWAY_IMAGE,
    openShellSandboxImage: process.env.OCC_TEST_OPENSHELL_SANDBOX_IMAGE,
    openShellSupervisorImage: process.env.OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE,
    openShellHelmPath: process.env.OCC_TEST_OPENSHELL_HELM,
    openShellHelmChart: process.env.OCC_TEST_OPENSHELL_HELM_CHART,
    openShellWorkspaceHelmChart: process.env.OCC_TEST_OPENSHELL_WORKSPACE_HELM_CHART,
    signal: t.signal,
  });
  assert.equal(process.env.OCC_TEST_OPENSHELL_HARNESS, "openclaw");
  await fixture.validateOpenShellPrerequisites();
  const modelKey = process.env.OPENAI_API_KEY;
  const modelName = normalizeOpenShellModelId(process.env.OCC_TEST_OPENAI_MODEL ?? "");
  assert.ok(modelKey, "The real OpenClaw startup requires an authorized model credential.");
  assert.ok(modelName.trim(), "The real OpenClaw startup requires an authorized model.");
  const platformNamespace = `oce-optional-${randomUUID().slice(0, 8)}`;
  const resources: {
    tenantNamespace?: string;
    worker?: ReturnType<typeof createControllerWorker>;
  } = {};
  t.after(async () => {
    await resources.worker?.stop();
    if (resources.tenantNamespace) {
      await fixture.kubectl(
        "delete",
        "namespace",
        resources.tenantNamespace,
        "--ignore-not-found=true",
        "--wait=false",
      );
    }
    await fixture.kubectl(
      "delete",
      "namespace",
      platformNamespace,
      "--ignore-not-found=true",
      "--wait=false",
    );
  });
  await fixture.kubectl("create", "namespace", platformNamespace);
  const gateway = await createEnvoyWorkspaceGatewayPlan(t, { platformNamespace }, fixture);
  Object.assign(gateway.routing, {
    endpointPort: await startWorkspaceGatewayHostRelay(t, gateway, { ...fixture, gatewayImage }),
  });
  const directory = await temporaryDirectory(t, "oce-optional-plugin-");
  const apiKeyPath = join(directory, "gateway-api-key");
  await writeFile(apiKeyPath, gateway.apiKey, { mode: 0o600 });
  const environment = {
    OCC_ISOLATED_FIXTURE: "1",
    OCC_INSTALLATION_SECRET_NAMESPACE: platformNamespace,
    OCC_GATEWAY_API_KEY_PATH: apiKeyPath,
    OCC_GATEWAY_CA_PATH: process.env.OCC_TEST_GATEWAY_CA_CERT_PATH,
  };
  const { controller, createApp, inject, state, principal } = await createPostgresAgentApp(t, {
    label: "native-optional-plugin",
    authSecret: "native-optional-plugin-postgres-session-secret",
  });
  const google = managedCliInstalls.find(({ id }) => id === "occ-plugin:google@1.0.0");
  const slack = managedMcpInstalls.find(({ id }) => id === "occ-plugin:slack@1.0.0");
  assert.ok(google && slack);
  const ports = [{ from: 443, to: 443 }];
  const modelGrant = {
    id: "model",
    binary: "/usr/local/bin/node",
    host: "api.openai.com",
    ports,
  };
  const independent = {
    id: "independent",
    binary: google.binaryPath,
    host: "storage.googleapis.com",
    ports,
  };
  const configuration = createOpenShellTokenServiceInstallationConfiguration({
    authentication: { mode: "kubeconfig", kubeconfigPath, context: kubernetesContext },
    platformNamespace,
    gatewayImage,
    codexImage,
    cluster: kubernetesContext.replace(/^k3d-/, ""),
  });
  const startup = asRecord(configuration)!;
  const drivers = asRecord(startup.drivers)!;
  const backend = asRecord((startup.backend as unknown[])[0])!;
  const sandbox = asRecord(asRecord(drivers.sandbox)?.configuration)!;
  const sandboxKubernetes = asRecord(sandbox.kubernetes)!;
  Object.assign(drivers, {
    plugin: [{ id: "occ-plugin", configuration: {} }],
  });
  configuration.drivers.compute.id = controller.selectedDriver("compute").id;
  Reflect.set(configuration.drivers.compute.configuration, "servicePrincipalCredentials", {
    mode: "disabled",
  });
  configuration.drivers.iam.id = controller.selectedDriver("iam").id;
  configuration.drivers.configuration.id = controller.selectedDriver("configuration").id;
  Object.assign(startup, {
    runtime: { nativeWorkerSupport: "custom-image" },
    sandboxNetworkPolicyCeiling: [
      modelGrant,
      independent,
      { id: "google", binary: google.binaryPath, host: "*.googleapis.com", ports },
      { id: "slack", binary: slack.binaryPath, host: slack.endpoint.host, ports },
    ],
  });
  Reflect.deleteProperty(configuration.drivers.compute.configuration.network, "gatewayClients");
  Object.assign(configuration.drivers.compute.configuration, { gatewayRouting: gateway.routing });
  configuration.drivers.compute.configuration.network.gatewayTrustedProxyCidrs =
    gateway.nativeOptions.gatewayAuth.trustedProxies;
  sandbox.gateway = {};
  sandboxKubernetes.serviceAccount = { mode: "gatewayConfigured" };
  Reflect.deleteProperty(asRecord(sandboxKubernetes.sandboxDataMount)!, "claimName");
  const initial = await loadInstallationFile(t, configuration, { environment });
  assert.ok(initial);
  controller.registerDriver(initial.secretDriver);
  controller.selectDriver("secret", initial.secretDriver.id);
  await installTokenServiceDriver(controller, initial, state);
  const owner = controller.selectedDriver("token_service");
  const instanceId = controller.currentTokenServiceInstanceId();
  assert.ok(instanceId);
  const createdNamespace = await inject("POST", "/namespaces", {
    name: `Optional Plugin ${randomUUID()}`,
  });
  assert.equal(createdNamespace.statusCode, 201, createdNamespace.body);
  const namespace = createdNamespace.json().data;
  const tenantNamespace = kubernetesNamespaceName(namespace.id);
  resources.tenantNamespace = tenantNamespace;
  assert.equal((await initial.computeDriver.ensureNamespace(namespace)).namespaceReady, true);
  await fixture.installOpenShellGateway(tenantNamespace, {
    sandboxServiceAccountName: "openshell-sandbox",
  });
  const forward = await fixture.startOpenShellGatewayPortForward(tenantNamespace);
  t.after(() => forward.stop());
  backend.configuration = {
    endpoint: forward.url,
    insecureTransport: "network-policy",
  };
  const runtime = await loadInstallationFile(t, configuration, { environment });
  assert.ok(runtime?.sandboxDriver);
  assert.ok(
    runtime.computeDriver.resolveSandboxNamespaceContext && runtime.sandboxDriver.ensureNamespace,
  );
  const sandboxContext = await runtime.computeDriver.resolveSandboxNamespaceContext(
    namespace,
    t.signal,
  );
  await runtime.sandboxDriver.ensureNamespace(sandboxContext);
  await controller.handleNamespaceLifecycle(principal.id, namespace.id, "ready");
  const delivery = credentialSourceDeliveryBinding(runtime);
  assert.ok(delivery);
  const native = new OpenClawController(controller.installation, {
    state,
    ...installationControllerOptions(runtime.installation),
    credentialSourceDelivery: delivery,
    namespaceLifecycleBindings: runtime.namespaceLifecycleBindings,
    backends: runtime.installation.backend,
    recordOperations: true,
  });
  for (const capability of ["iam", "configuration", "secret"] as const) {
    const driver = controller.selectedDriver(capability);
    native.registerDriver(driver);
    native.selectDriver(capability, driver.id);
  }
  native.registerDriver(runtime.computeDriver);
  native.selectDriver("compute", runtime.computeDriver.id);
  await installTokenServiceDriver(native, runtime, state);
  installSelectedSandboxDrivers(native, runtime);
  native.installPluginDrivers([new OCCPluginDriver()]);
  const app = createApp(native);
  const request = async (method: string, path: string, body?: unknown, expected = 200) => {
    const response = await inject(method, path, body, app);
    assert.equal(response.statusCode, expected, response.body);
    return response.json().data;
  };
  const base = `/namespaces/${namespace.id}`;
  const model = await request(
    "POST",
    `${base}/credential-sources`,
    {
      name: "Model",
      type: "static",
      config: { provider_preset: "openai" },
      secret: modelKey,
    },
    201,
  );
  const slackTemplate = await request(
    "POST",
    "/connection-templates",
    {
      namespaceId: namespace.id,
      displayName: "Slack MCP",
      mode: "static_bearer",
      destinations: [
        {
          method: "POST",
          host: slack.endpoint.host,
          port: slack.endpoint.port,
          path: slack.endpoint.path,
        },
      ],
    },
    201,
  );
  const slackSource = await request(
    "POST",
    `${base}/credential-sources`,
    {
      name: "Slack",
      type: "static",
      connectionTemplateId: slackTemplate.id,
      secret: randomUUID(),
    },
    201,
  );
  const googleSlot = google.credentials.account;
  assert.ok(googleSlot);
  const scopes = ["https://www.googleapis.com/auth/gmail.modify"];
  const gmail = { host: "gmail.googleapis.com", port: 443, path: "/gmail/v1/users/me/messages" };
  const templateSettings = {
    displayName: "Google account",
    mode: "manual",
    issuer: googleSlot.issuer,
    authorizationUrl: `${googleSlot.issuer}/o/oauth2/v2/auth`,
    tokenUrl: googleSlot.tokenEndpoint,
    scopes,
    destinations: [gmail],
  };
  const googleTemplate = await request(
    "POST",
    "/connection-templates",
    {
      ...templateSettings,
      namespaceId: namespace.id,
    },
    201,
  );
  const client = await request(
    "POST",
    "/credential-clients",
    {
      kind: "oauth2",
      namespaceId: namespace.id,
      issuer: googleSlot.issuer,
      tokenUrl: googleSlot.tokenEndpoint,
      displayName: "Google fixture client",
      clientId: randomUUID(),
      tokenEndpointAuthMethod: "none",
    },
    201,
  );
  const googleSource = await owner.createSource(
    {
      type: "oauth2-refresh-token",
      namespaceId: namespace.id,
      name: "Google",
      connectionTemplateId: googleTemplate.id,
      consent: {
        kind: "connection_template",
        ownerPrincipalId: principal.id,
        version: googleTemplate.current.version,
        oauthClientId: client.id,
      },
      grant: {
        accessToken: randomUUID(),
        refreshToken: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        requestedScopes: scopes,
        grantedScopes: scopes,
      },
    },
    t.signal,
  );
  const values = createHarnessConfiguration("openclaw", modelName);
  Object.assign(values.gateway, {
    auth: { ...nativeAdminGatewayAuth(), password: values.gateway.auth.password },
    allowRealIpFallback: true,
    trustedProxies: gateway.nativeOptions.gatewayAuth.trustedProxies,
  });
  const agentConfig = await request(
    "POST",
    `${base}/configurations`,
    { kind: "agent", values },
    201,
  );
  const agent = await request(
    "POST",
    `${base}/agents`,
    {
      name: "Optional Plugin",
      executionMode: "dedicated",
      configurationId: agentConfig.id,
      harnessAuth: { method: "credential_source", sourceId: model.id },
      credentialSources: [{ sourceId: model.id }],
    },
    201,
  );
  const agentPath = `${base}/agents/${agent.id}`;
  await request("PATCH", agentPath, {
    configurationId: agentConfig.id,
    plugins: {
      [google.id]: {
        enabled: true,
        driverPolicy: {
          releaseSha256: google.releaseSha256,
          credentials: { account: googleSource.id },
        },
      },
      [slack.id]: {
        enabled: true,
        driverPolicy: {
          releaseSha256: slack.releaseSha256,
          credentials: { [slack.slotId]: slackSource.id },
          toolNames: ["slack_search_public"],
        },
      },
    },
  });
  await request("PATCH", `${agentPath}/sandbox-policy/networking/editing`, { enabled: true });
  await request("PUT", `${agentPath}/sandbox-policy/networking`, {
    expectedVersion: 1,
    additions: [modelGrant, independent],
  });
  const revision = await request("POST", `${agentPath}/deploy`, {}, 202);
  const admitted = await state.read((view) =>
    view.revisions.findRevision(namespace.id, agent.id, revision.id),
  );
  assert.ok(admitted?.credentialDeployment);
  assert.equal(admitted.credentialDeployment.bindings.length, 3);
  const custody = await owner.resolveCredential(
    {
      sourceRef: { kind: "credential_source", namespaceId: namespace.id, id: slackSource.id },
      tokenServiceInstanceId: instanceId,
    },
    t.signal,
  );
  const service = new GrpcOpenShellGatewayClient({ endpoint: forward.url });
  t.after(() => service.close());
  const worker = createControllerWorker({
    pool: new pg.Pool({ connectionString: databaseUrl }),
    drivers: runtime,
    pollIntervalMs: 100,
    emit() {},
  });
  resources.worker = worker;
  await worker.start();
  await waitForOpenShellRevisionActivation(
    (description, read) => waitFor(description, read, { timeoutMs: 180_000, intervalMs: 500 }),
    {
      request: async (method, path) => {
        try {
          const response = await inject(method, path, undefined, app);
          const status = response.statusCode;
          if (status !== 200) {
            return { status, data: undefined };
          }
          const data = asRecord(asRecord(response.json())?.data);
          assert.ok(data);
          return { status, data };
        } catch {
          throw new Error("OpenShell activation status read failed.");
        }
      },
      agentPath,
      revisionId: revision.id,
      reportDeploymentStatusOnTimeout: true,
    },
  );
  assert.ok(runtime.sandboxDriver.harnessResource);
  const target = runtime.sandboxDriver.harnessResource({
    namespace: sandboxContext.namespace,
    revision: admitted,
  });
  const check = async (withdrawn: boolean) => {
    const sandbox = await service.getSandbox(
      { workspace: tenantNamespace, name: target.resourceName },
      t.signal,
    );
    const loaded = await service.getPolicyStatus(
      { workspace: tenantNamespace, sandbox: target.resourceName },
      t.signal,
    );
    const configured = await service.getSandboxConfig(
      tenantNamespace,
      target.resourceName,
      t.signal,
    );
    const providers = sandbox?.spec?.providers;
    assert.ok(Array.isArray(providers));
    assert.equal(loaded.state, "POLICY_STATUS_LOADED");
    assert.equal(loaded.activeVersion, loaded.version);
    assert.ok(configured.policy);
    const policies: readonly unknown[] = [loaded.policy, configured.policy];
    for (const binding of admitted.credentialDeployment!.bindings) {
      const wanted = binding.sourceRef.id !== slackSource.id || !withdrawn;
      const provider = openShellCredentialProviderName(binding);
      assert.equal(providers.includes(provider), wanted);
      assert.equal(Boolean(await service.getProvider(tenantNamespace, provider, t.signal)), wanted);
      assert.equal(
        Boolean(await service.getProviderProfile(tenantNamespace, provider, t.signal)),
        wanted,
      );
      for (const policy of policies) {
        assert.equal(
          endpoints(policy).some(
            (entry) => asRecord(entry.credential_binding)?.provider === provider,
          ),
          wanted,
        );
      }
    }
    for (const policy of policies) {
      assert.ok(
        endpoints(policy).some(
          (entry) => entry.host === independent.host && !entry.credential_binding,
        ),
      );
      if (withdrawn) {
        assert.equal(
          endpoints(policy).some((entry) => entry.host === slack.endpoint.host),
          false,
        );
      }
    }
    assert.equal(
      (await request("GET", `${base}/credential-sources/${slackSource.id}`)).state,
      "ready",
    );
    const retained = await owner.resolveCredential(
      {
        sourceRef: { kind: "credential_source", namespaceId: namespace.id, id: slackSource.id },
        tokenServiceInstanceId: instanceId,
      },
      t.signal,
    );
    assert.equal(retained.version, custody.version);
    const retainedProviders = new Set(
      admitted
        .credentialDeployment!.bindings.filter((binding) => binding.sourceRef.id !== slackSource.id)
        .map(openShellCredentialProviderName),
    );
    return policies.map((policy) =>
      networkEntries(policy)
        .filter(({ endpoint }) => {
          const provider = asRecord(endpoint.credential_binding)?.provider;
          return (
            (typeof provider === "string" && retainedProviders.has(provider)) ||
            (endpoint.host === independent.host && !endpoint.credential_binding)
          );
        })
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    );
  };
  const retainedBefore = await check(false);
  await request(
    "POST",
    `${agentPath}/credential-sources/${slackSource.id}/withdraw`,
    undefined,
    202,
  );
  await waitFor(
    "optional Slack withdrawal to be revoked",
    async () =>
      (await request("GET", `${agentPath}/credential-sources/${slackSource.id}/withdrawal`))
        .state === "revoked"
        ? true
        : undefined,
    { timeoutMs: 120_000, intervalMs: 500 },
  );
  const retainedAfter = await check(true);
  assert.deepEqual(retainedAfter, retainedBefore);
  assert.equal((await request("GET", agentPath)).activeRevisionId, revision.id);
}

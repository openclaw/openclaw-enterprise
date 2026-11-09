import assert from "node:assert/strict";
import test from "node:test";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type {
  AgentRevision,
  ComputeRevisionContext,
  CredentialProxyDriver,
  EgressInstallation,
  ProtectedWorkspaceEndpoint,
  ProtectedWorkspaceSandboxDriver,
  ProxyPlan,
  SandboxHarnessStatus,
} from "../../packages/contracts/src/index.ts";
import { InstalledDriver } from "../../packages/occ/src/index.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { providerEndpointFixture } from "../fixtures/kubernetes-provider-endpoint.mjs";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";
import { admitRevisionHarness, tenant } from "../helpers/kubernetes-routed-scenarios.mjs";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";

const generationSha256 = "1".repeat(64);
const startupSha256 = "2".repeat(64);
const selector = "OPENCLAW_CODEX_REMOTE_WORKSPACE_BINDING";
const bindingDirectory = "/etc/openclaw-box-owner";

test("Compute binds the reserved original before enrollment and activates only a serving acknowledged original", async (t) => {
  const { caBundle } = await harnessTlsFixture(t);
  const otherCa = (await harnessTlsFixture(t)).caBundle;
  const url = "wss://protected.example.test:8080/";
  const workspaceRoot = "/home/node/workspace";
  const original = { purpose: "normal-protected-codex-workspace", generationSha256 } as const;
  const reserved: ProtectedWorkspaceEndpoint = {
    url,
    tls: { caBundle },
    workspaceRoot,
    original: { ...original, state: "reserved" },
  };
  const acknowledged: ProtectedWorkspaceEndpoint = {
    ...reserved,
    original: { ...original, state: "release-acknowledged", startupSha256 },
  };
  let endpoint: ProtectedWorkspaceEndpoint | undefined;
  let status: SandboxHarnessStatus = { state: "starting" };
  let afterStatus: (() => void) | undefined;
  let readyToEnroll = false;
  const events: string[] = [];
  const fixture = providerEndpointFixture({
    harnessEndpoint: async () =>
      assert.fail("the protected revision cannot use the ordinary endpoint"),
  });
  const sandbox: ProtectedWorkspaceSandboxDriver = {
    ...fixture.sandbox,
    capability: "sandbox",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    facets: ["networking"],
    cleanup: assert.fail,
    validateWorkspaceSetup() {},
    provisionHarness: fixture.sandbox.provisionHarness!.bind(fixture.sandbox),
    repositoryAccess: {
      routeReadiness: () => "ready",
      materialSettledAt: () => undefined,
      isRouteBlockedError: () => false,
      verifyExecution: assert.fail,
      retireExpired: assert.fail,
    },
    async protectedWorkspaceEndpoint(context) {
      events.push("endpoint");
      assert.equal(context.revision, revision);
      assert.equal(context.namespace.id, revision.namespaceId);
      assert.equal(Object.hasOwn(context, "requirements"), false);
      assert.equal(Object.hasOwn(context, "transportToken"), false);
      return endpoint;
    },
    async enrollHarness(context, committed, release) {
      events.push("enroll");
      assert.equal(context.revision, revision);
      assert.deepEqual(context.requirements.proxyWiring?.plan, plan);
      assert.equal(committed, installation);
      const envelope = await release("cb9e2850-30d9-4a57-8b60-805ea023d8a8");
      assert.equal(typeof envelope.signature, "string");
      events.push("signed");
    },
    async harnessStatus(context) {
      events.push("status");
      assert.ok("protectedWorkspaceEndpoint" in context);
      assert.equal(context.protectedWorkspaceEndpoint, true);
      assert.equal(context.revision, revision);
      assert.equal(context.transportToken, "test-transport");
      assert.equal(Object.hasOwn(context, "requirements"), false);
      afterStatus?.();
      return status;
    },
  };
  const owner = { id: "fixture", generation: 1 };
  const proxy: CredentialProxyDriver = {
    id: sandbox.id,
    implementation: sandbox.implementation,
    capability: "credential_proxy",
    sourceControl: {
      backend: owner,
      sender: owner,
      resolver: owner,
      providers: [],
      async assertAvailable() {
        return { profile: "github_repository", authorization: "online-request" };
      },
    },
    async configureRevision({ plan }) {
      return { plan, configuration: {} };
    },
    async wiringStatus() {
      events.push("installation");
      return readyToEnroll ? installation : undefined;
    },
    async verifyInstallation() {
      return true;
    },
    bindRepositoryGit: () => assert.fail("no Worker authority binding in the Compute fixture"),
    removeRevision: () => assert.fail("no protected removal in the Compute fixture"),
  };
  const registration = new InstalledDriver(
    { id: sandbox.id, implementation: sandbox.implementation, configuration: {} },
    { capabilities: { sandbox, credential_proxy: proxy } },
  );
  const driver = new KubernetesComputeDriver(fixture.driver["options"], {
    protectedDriver: registration,
    nodeEnrollment: fixture.driver["nodeEnrollment"],
  });
  // Reuse the conformance fixture's Kubernetes wire responses, not its Compute implementation.
  driver["apiClients"] = Promise.resolve(
    fixture.clients as unknown as Awaited<NonNullable<(typeof driver)["apiClients"]>>,
  );
  const base: AgentRevision = fixture.revision;
  const plan: ProxyPlan = {
    id: "protected-workspace-plan",
    generation: 1,
    driver: registration.ref,
    sandboxDriverId: sandbox.id,
    egressDriverId: proxy.id,
    execution: {
      installationId: "installation",
      namespaceId: base.namespaceId,
      agentId: base.agentId,
      revisionId: base.id,
      servicePrincipalId: base.servicePrincipalId,
      executionId: "original-execution",
    },
    routes: [],
    repositoryGitAuthorization: "online-request",
    repositoryGit: {
      driver: { id: "repo", implementation: "github" },
      deadlineWallMs: Date.now() + 120_000,
      bindings: [
        {
          profile: "github-repository",
          repositoryRef: "owner/repo",
          backendId: "repo",
          grant: { providerInstanceId: "provider", repositoryId: "repo", grantId: "grant" },
        },
      ],
    },
  };
  const admitted: AgentRevision = admitRevisionHarness(driver, {
    ...base,
    compute: { ...base.compute },
    revision: base.revision + 1,
    harnessAuth: { method: "runtime" },
    executionAdmission: { mode: "protected", version: 5 },
    egressPlan: plan,
  });
  // Exercise the normal admitted revision store and read boundary. The marker is
  // produced by Compute above, rather than copied from user configuration or the provider.
  assert.equal(admitted.compute.admission, "protected-workspace:v1:");
  const store = new InMemoryPlatformState();
  await store.transact(async (unit) => {
    await unit.installations.createInstallation({
      id: plan.execution.installationId,
      name: "Endpoint admission",
      createdAt: admitted.createdAt,
    });
    await unit.namespaces.createNamespace({ ...tenant, status: "ready" });
    await unit.configurations.createConfiguration({
      id: admitted.configurationId,
      namespaceId: admitted.namespaceId,
      kind: "agent",
      generation: admitted.configurationGeneration,
      createdAt: admitted.createdAt,
    });
    await unit.agents.createAgent({
      id: admitted.agentId,
      namespaceId: admitted.namespaceId,
      name: "Endpoint admission",
      configurationId: admitted.configurationId,
      servicePrincipalId: admitted.servicePrincipalId,
      backendId: admitted.backendId,
      gatewayManagedMode: admitted.gatewayManagedMode,
      harnessAuth: admitted.harnessAuth,
      executionMode: "dedicated",
      status: "active",
      desiredRuntimeState: "stopped",
      createdAt: admitted.createdAt,
    });
    await unit.revisions.createRevision(admitted);
  });
  const persisted = await store.read((unit) =>
    unit.revisions.findRevision(admitted.namespaceId, admitted.agentId, admitted.id),
  );
  assert.ok(persisted);
  const revision = persisted;
  assert.deepEqual(revision.compute, admitted.compute);
  const installation: EgressInstallation = {
    plan,
    sandboxId: "original-sandbox",
    sender: owner,
    installedAt: "2026-11-09T00:00:00Z",
    enforcement: {
      authorityScope: "execution",
      instanceId: "instance",
      configurationId: "configuration",
      policyHash: "policy",
      repositoryGitRecipient: {
        authorization: "online-request",
        deliveryProfile: "github_repository",
        providerId: "provider",
        attachmentEpoch: "attachment",
        processInstanceId: "process",
        networkInstanceId: "network",
      },
    },
  };
  const context: ComputeRevisionContext = {
    secretEnvironment: [],
    harnessAuth: { method: "runtime" },
    async recordEgressInstallation() {
      events.push("commit");
    },
    currentEgressInstallation: async () => installation,
  };
  const configMap = driver["harnessTrustName"](revision.agentId, revision.id);
  const pinKey = fixture.key("ConfigMap", configMap, fixture.gatewayNamespace);
  const anchorName = driver["gatewayConfigurationName"](revision);
  const annotation = "openclaw.dev/protected-workspace-pin-sha256";
  const configMapPort = fixture.core as unknown as {
    patchNamespacedConfigMap(request: {
      name: string;
      namespace: string;
      body: {
        kind?: string;
        metadata: { resourceVersion?: string; annotations?: Record<string, string> };
      };
    }): Promise<void>;
  };
  const reconcileConfigMap = configMapPort.patchNamespacedConfigMap;
  configMapPort.patchNamespacedConfigMap = async (request) => {
    if (request.name !== anchorName) {
      return reconcileConfigMap(request);
    }
    const previous = fixture.read("ConfigMap", anchorName, fixture.gatewayNamespace);
    if (request.body.kind !== undefined) {
      await reconcileConfigMap(request);
      const created = fixture.read("ConfigMap", anchorName, fixture.gatewayNamespace);
      fixture.save({
        ...created,
        metadata: { ...created.metadata, uid: "anchor-uid", resourceVersion: "1" },
      });
      return;
    }
    // The real caller submits a metadata-only merge patch carrying the observed version.
    assert.equal(request.body.metadata.resourceVersion, previous.metadata.resourceVersion);
    assert.deepEqual(Object.keys(request.body.metadata.annotations ?? {}), [annotation]);
    assert.equal(previous.metadata.annotations?.[annotation], undefined);
    fixture.save({
      ...previous,
      metadata: {
        ...previous.metadata,
        resourceVersion: "2",
        annotations: { ...previous.metadata.annotations, ...request.body.metadata.annotations },
      },
    });
    events.push("anchor");
  };
  let creates = 0;
  Object.assign(fixture.core, {
    async createNamespacedConfigMap({ body }: { body: { metadata: { name: string } } }) {
      assert.equal(body.metadata.name, configMap);
      assert.equal(fixture.objects.has(pinKey), false);
      creates++;
      events.push("pin");
      fixture.save(body);
      return body;
    },
  });
  const { repositoryGit, repositoryGitAuthorization: _authorization, ...planWithoutGit } = plan;
  assert.ok(repositoryGit);
  for (const unsupported of [
    {
      ...revision,
      executionAdmission: { mode: "protected", version: 3 },
      egressPlan: planWithoutGit,
    },
    {
      ...revision,
      executionAdmission: { mode: "protected", version: 4 },
      egressPlan: { ...planWithoutGit, repositoryGit },
    },
  ] satisfies AgentRevision[]) {
    await assert.rejects(
      driver.prepareRevision(unsupported, context),
      /protected workspace Driver does not support this execution admission/,
    );
    await assert.rejects(
      driver.activateRevision(unsupported, context),
      /protected workspace Driver does not support this execution admission/,
    );
  }
  assert.equal(events.length, 0);
  assert.equal(fixture.provisions.length, 0);
  assert.equal(fixture.endpoints.length, 0);
  await assert.rejects(
    driver.prepareRevision(
      {
        ...revision,
        configuration: { ...revision.configuration, env: { vars: { [selector]: "/tmp/foreign" } } },
      },
      context,
    ),
    /set only by Compute for a protected workspace/,
  );
  assert.equal(fixture.provisions.length, 0);
  await assert.rejects(
    driver.prepareRevision(revision, {
      ...context,
      workspaceSetup: {
        id: "fresh-workspace-setup",
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        files: { "AGENTS.md": "Initial workspace instructions" },
        completed: false,
      },
    }),
    /requires retained Agent-owned node setup before provisioning/,
  );
  assert.equal(fixture.writes.length, 0);
  assert.equal(fixture.provisions.length, 0);
  assert.equal(fixture.gateway(), undefined);
  assert.equal(events.length, 0);

  // A distinct controlled placement has a predecessor Gateway and a still-valid
  // unspent Agent-owned setup. A completed predecessor cannot attest that setup.
  await fixture.prepare({ ...base, id: "serving-predecessor" });
  fixture.setGatewayServing();
  fixture.setSetupAvailable(true);
  const readSecret = fixture.core.readNamespacedSecret;
  let nodePaired = false;
  Object.assign(fixture.core, {
    async readNamespacedSecret(input: { name: string }) {
      const secret = await readSecret(input);
      if (input.name !== driver["workspaceNodeName"](revision)) {
        return secret;
      }
      const { deviceId, ...data } = secret.data ?? {};
      return {
        ...secret,
        data: {
          ...data,
          ...(nodePaired ? { deviceId } : {}),
          setupId: Buffer.from("retained-setup-id").toString("base64"),
          setupCode: Buffer.from("retained-setup").toString("base64"),
        },
      };
    },
  });
  fixture.observePods([fixture.pod("original")]);

  const prepare = () => driver.prepareRevision(revision, context);
  const activate = () => driver.activateRevision(revision, context);
  const beforeMissingReserve = fixture.writes.length;
  assert.equal((await prepare()).ready, false);
  assert.equal(creates, 0);
  assert.ok(!events.includes("installation"));
  assert.equal(
    fixture.writes.slice(beforeMissingReserve).filter(({ kind }) => kind === "Deployment").length,
    0,
  );
  events.length = 0;

  endpoint = reserved;
  const predecessor = fixture.gateway();
  assert.equal((await prepare()).ready, false);
  assert.deepEqual(events, ["endpoint", "anchor", "pin", "installation"]);
  assert.deepEqual(fixture.gateway(), predecessor);
  assert.equal(creates, 1);
  const pin = fixture.read("ConfigMap", configMap, fixture.gatewayNamespace);
  assert.equal(pin.immutable, true);
  assert.deepEqual(pin.data, {
    "binding.json": JSON.stringify({ url, workspaceRoot, generationSha256 }),
    "ca.pem": caBundle,
  });
  const retainedAnchor = fixture.read("ConfigMap", anchorName, fixture.gatewayNamespace);
  assert.match(retainedAnchor.metadata.annotations[annotation], /^[0-9a-f]{64}$/u);
  fixture.objects.delete(pinKey);
  endpoint = { ...reserved, original: { ...reserved.original, generationSha256: "3".repeat(64) } };
  await assert.rejects(prepare(), /previously bound protected workspace has no existing pin/);
  assert.equal(creates, 1);
  assert.equal(fixture.objects.has(pinKey), false);
  assert.deepEqual(fixture.gateway(), predecessor);
  assert.deepEqual(fixture.read("ConfigMap", anchorName, fixture.gatewayNamespace), retainedAnchor);
  endpoint = {
    ...acknowledged,
    original: { ...acknowledged.original, generationSha256: "3".repeat(64) },
  };
  nodePaired = true;
  await assert.rejects(activate(), /immutable protected workspace pin is missing or changed/);
  nodePaired = false;
  assert.equal(creates, 1);
  assert.deepEqual(fixture.gateway(), predecessor);
  endpoint = reserved;
  await assert.rejects(prepare(), /previously bound protected workspace has no existing pin/);
  assert.equal(creates, 1);
  const boundRead = sandbox.protectedWorkspaceEndpoint;
  // Both deployment-side witnesses are unavailable: no pin, and the Gateway still
  // belongs to the predecessor. The persisted selection alone refuses downgrade.
  fixture.objects.delete(pinKey);
  Reflect.deleteProperty(sandbox, "protectedWorkspaceEndpoint");
  events.length = 0;
  await assert.rejects(activate(), /protected workspace Driver is unavailable/);
  assert.equal(events.length, 0);
  assert.equal(fixture.endpoints.length, 0);
  assert.deepEqual(fixture.gateway(), predecessor);
  assert.equal(creates, 1);
  sandbox.protectedWorkspaceEndpoint = boundRead;
  fixture.save(pin);
  fixture.objects.delete(fixture.key("Deployment", fixture.gatewayName, fixture.gatewayNamespace));
  assert.equal((await prepare()).ready, false);
  const gateway = fixture.gateway();
  const container = gateway.spec.template.spec.containers[0];
  assert.deepEqual(
    gateway.spec.template.spec.volumes.find(
      ({ name }: { name: string }) => name === "harness-trust",
    )?.configMap.items,
    ["binding.json", "ca.pem"].map((file) => ({ key: file, path: file, mode: 0o444 })),
  );
  assert.ok(
    container.env.some(
      (item: { name: string; value?: string }) =>
        item.name === selector && item.value === `${bindingDirectory}/binding.json`,
    ),
  );
  assert.deepEqual(
    container.volumeMounts.filter((mount: { name: string }) => mount.name === "harness-trust"),
    ["binding.json", "ca.pem"].map((file) => ({
      name: "harness-trust",
      mountPath: `${bindingDirectory}/${file}`,
      subPath: file,
      readOnly: true,
    })),
  );
  assert.ok(
    !fixture.provisions.some(({ requirements }) =>
      requirements.environment.some((item: { name: string }) => item.name === selector),
    ),
  );
  nodePaired = true;
  await assert.rejects(activate(), /protected workspace release is unavailable/);

  readyToEnroll = true;
  events.length = 0;
  assert.equal((await prepare()).ready, false);
  assert.deepEqual(events, ["endpoint", "installation", "commit", "enroll", "signed", "endpoint"]);
  endpoint = acknowledged;
  await assert.rejects(activate(), /protected workspace is not serving/);
  assert.ok(events.includes("status"));
  status = { state: "serving" };

  for (const replacement of [
    { ...acknowledged, url: "wss://replacement.example.test:8080/" },
    { ...acknowledged, tls: { caBundle: otherCa } },
    { ...acknowledged, workspaceRoot: "/different" },
    { ...acknowledged, original: { ...acknowledged.original, generationSha256: "3".repeat(64) } },
  ] satisfies ProtectedWorkspaceEndpoint[]) {
    endpoint = replacement;
    events.length = 0;
    await assert.rejects(activate(), /immutable protected workspace pin is missing or changed/);
    assert.deepEqual(events, ["endpoint"]);
  }
  endpoint = acknowledged;
  afterStatus = () => {
    endpoint = undefined;
  };
  await assert.rejects(activate(), /changed during the serving check/);
  afterStatus = undefined;
  endpoint = acknowledged;

  fixture.objects.delete(pinKey);
  await assert.rejects(activate(), /immutable protected workspace pin is missing or changed/);
  endpoint = reserved;
  await assert.rejects(prepare(), /previously bound protected workspace has no existing pin/);
  assert.equal(creates, 1);
  fixture.save(pin);
  endpoint = acknowledged;

  Reflect.deleteProperty(sandbox, "protectedWorkspaceEndpoint");
  await assert.rejects(activate(), /protected workspace Driver is unavailable/);
  sandbox.protectedWorkspaceEndpoint = boundRead;
  assert.equal(fixture.endpoints.length, 0);

  const provision = sandbox.provisionHarness;
  Reflect.deleteProperty(sandbox, "provisionHarness");
  events.length = 0;
  await assert.rejects(prepare(), /protected workspace Driver is unavailable/);
  await assert.rejects(activate(), /protected workspace Driver is unavailable/);
  assert.equal(events.length, 0);
  assert.equal(fixture.endpoints.length, 0);
  assert.deepEqual(fixture.read("ConfigMap", configMap, fixture.gatewayNamespace), pin);
  sandbox.provisionHarness = provision;

  fixture.setGatewayServing();
  await activate();
  assert.equal(creates, 1);
  assert.deepEqual(fixture.read("ConfigMap", configMap, fixture.gatewayNamespace), pin);
  assert.deepEqual(fixture.read("ConfigMap", anchorName, fixture.gatewayNamespace), retainedAnchor);
  assert.equal(fixture.endpoints.length, 0);
});

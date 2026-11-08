import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import test, { type TestContext } from "node:test";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { ControllerWorker } from "../../apps/controller/src/worker.ts";
import { githubMetadataGrant } from "../../packages/contracts/src/index.ts";
import type {
  AgentRevision,
  ProxyPlan,
  ConfigurationDriver,
  CredentialSource,
  CredentialSourceControl,
} from "../../packages/contracts/src/index.ts";
import type {
  ClaimedWork,
  OpenClawController,
  PlatformStateStore,
  PlatformUnitOfWork,
} from "../../packages/occ/src/index.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { postgresApp } from "../helpers/postgres-egress-app.mjs";
import { staticEgressFixture } from "../helpers/static-egress.mjs";

/**
 * Gives the fixture real Kubernetes Compute auth validation, then makes the Gateway catalog
 * change the source type's login mode after its first read. Admission reads that entry once, so
 * validating against a later read would refuse the descriptor that supplied the login mode.
 */
async function catalogChangingAfterAdmission(
  t: TestContext,
  controller: OpenClawController,
  sourceType: string,
) {
  const gateway = controller.selectedDriver("credential_gateway");
  const compute = createTestKubernetesComputeDriver("admission-compute", {
    gatewayRuntime: true,
    sandboxDriver: controller.selectedDriver("sandbox"),
    credentialGatewayDriver: gateway,
  });
  // Use real Compute auth validation; the fixture keeps runtime placement and effects simulated.
  controller.selectedDriver("compute").validateHarnessAuth =
    compute.validateHarnessAuth.bind(compute);
  const offered = await gateway.listSourceTypes({ signal: AbortSignal.timeout(5_000) });
  const original = offered.find((entry) => entry.type === sourceType);
  const harnessAuth = original?.harnessAuth;
  assert.ok(harnessAuth);
  assert.equal(harnessAuth.loginMode, "api_key");
  const changed = offered.map((entry) =>
    entry === original
      ? { ...entry, harnessAuth: { ...harnessAuth, loginMode: "codex_pat" as const } }
      : entry,
  );
  let calls = 0;
  const catalog = t.mock.method(gateway, "listSourceTypes", async () =>
    ++calls === 1 ? offered : changed,
  );
  /** The same catalog, but Compute refuses the source's model provider. */
  const refuseProvider = () =>
    catalog.mock.mockImplementation(async () =>
      offered.map((entry) =>
        entry === original
          ? { ...entry, harnessAuth: { ...harnessAuth, modelProvider: "anthropic" } }
          : entry,
      ),
    );
  return { compute, gateway, catalog, refuseProvider };
}

test("deployment validates Harness authentication with the source descriptor that supplied its login mode", async (t) => {
  const f = await staticEgressFixture(t, { admitRevision: false });
  const controller: OpenClawController = f.controller;
  assert.equal(f.source.ownerCapability, "credential_gateway");
  // The catalog changes after Harness admission; the independent listed-source check still runs.
  const { gateway, catalog, refuseProvider } = await catalogChangingAfterAdmission(
    t,
    controller,
    f.source.type,
  );
  const deploy = () =>
    f.request("POST", `/namespaces/${f.namespace.id}/agents/${f.agent.id}/deploy`);
  const admitted = await deploy();
  const calls = catalog.mock.callCount();
  assert.equal(admitted.status, 202, JSON.stringify({ response: admitted.body, calls }));
  assert.equal(calls, 2);
  const revisions = () =>
    controller.transact((state) => state.revisions.listRevisions(f.namespace.id, f.agent.id));
  const saved = await revisions();
  assert.deepEqual(saved[0]?.harnessAuth, {
    method: "credential_source",
    sourceId: f.source.id,
    credentialGatewayId: gateway.id,
    sourceType: f.source.type,
    loginMode: "api_key",
  });

  // Another admission must resolve its own descriptor and still let Compute reject its provider.
  refuseProvider();
  assert.equal((await deploy()).status, 409);
  assert.equal(catalog.mock.callCount(), 4);
  assert.deepEqual(await revisions(), saved);
});

test(
  "provisioning validates Harness authentication with the source descriptor that supplied its login mode (PostgreSQL)",
  requiresPostgres,
  async (t) => {
    const f = await staticEgressFixture(t, {
      admitRevision: false,
      // Provisioning keeps its job in PostgreSQL and needs exact Configuration create and inspect.
      appFactory: async (context: TestContext, options: object = {}) => {
        const app = await postgresApp(context, options);
        const configuration: ConfigurationDriver = {
          ...createTestConfigurationDriver({ id: "provisioning-configuration", exact: true }),
          capability: "configuration",
        };
        app.controller.registerDriver(configuration);
        app.controller.selectDriver(configuration.capability, configuration.id);
        return app as unknown as Awaited<ReturnType<typeof createConsoleAppFixture>>;
      },
    });
    const controller: OpenClawController = f.controller;
    const { compute, catalog, refuseProvider } = await catalogChangingAfterAdmission(
      t,
      controller,
      f.source.type,
    );
    // Real Kubernetes provisioning admission. No provisioning worker runs here, so the runtime
    // credential members are only the capability the request requires; they are never called.
    Object.assign(controller.selectedDriver("compute"), {
      agentProvisioning: compute.agentProvisioning,
      validateAgentProvisioning: compute.validateAgentProvisioning.bind(compute),
      getAgentRuntimeCredentialStatus: compute.getAgentRuntimeCredentialStatus.bind(compute),
      provisionAgentRuntimeCredentials: compute.provisionAgentRuntimeCredentials.bind(compute),
    });
    const provision = (name: string, requestId: string) =>
      f.request("POST", `/namespaces/${f.namespace.id}/agents/provision`, {
        body: {
          requestId,
          name,
          executionMode: "dedicated",
          configuration: {
            kind: "agent",
            values: {
              agents: {
                defaults: {
                  model: { primary: "codex/fixture-model" },
                  models: { "codex/fixture-model": { agentRuntime: { id: "codex" } } },
                },
              },
            },
          },
          harnessAuth: { method: "credential_source", sourceId: f.source.id },
        },
      });
    // Provisioning admission reads the catalog once and validates against that entry.
    const admitted = await provision("provisioned-agent", `req_${randomUUID()}`);
    const calls = catalog.mock.callCount();
    assert.equal(admitted.status, 202, JSON.stringify({ response: admitted.body, calls }));
    assert.equal(calls, 1);
    const queued = await controller.transact((state) =>
      state.provisioning.findByWorkId(admitted.body.data.provisioning.workId),
    );
    assert.ok(queued);
    assert.equal(queued.status, "queued");

    // Another request resolves its own descriptor, and Compute still refuses its provider. The
    // refusal comes after the job row is written, so the transaction must not keep it.
    refuseProvider();
    const refusedRequest = `req_${randomUUID()}`;
    assert.equal((await provision("refused-agent", refusedRequest)).status, 409);
    assert.equal(catalog.mock.callCount(), 2);
    assert.equal(
      await controller.transact((state) =>
        state.provisioning.findByRequest(f.namespace.id, queued.actorId, refusedRequest),
      ),
      undefined,
    );
  },
);

test("credential exchange consults revision history only for inactive executions", async (t) => {
  let revisionListings = 0;
  const f = await staticEgressFixture(t, {
    recordInstallation: false,
    appFactory: (context, options) =>
      createConsoleAppFixture(context, {
        ...options,
        wrapState: (state: PlatformStateStore): PlatformStateStore => ({
          read: (work) => state.read(work),
          transact: (work) =>
            state.transact((unit) =>
              work({
                ...unit,
                revisions: {
                  ...unit.revisions,
                  listRevisionMetadata: (...args) => {
                    revisionListings += 1;
                    return unit.revisions.listRevisionMetadata(...args);
                  },
                },
              }),
            ),
        }),
      }),
  });
  assert.ok("revision" in f);
  await f.controller.transact((unit: PlatformUnitOfWork) =>
    unit.credentialSources.recordEgressInstallation(f.installation),
  );

  // A newly provisioned execution can probe before the Agent activates it.
  revisionListings = 0;
  assert.ok((await f.resolve(f.capture())).ready);
  assert.equal(revisionListings, 1);

  await f.activateRevision(f.namespace.id, f.agent.id, f.revision.id);
  const successor = await f.deployAgent(f.namespace.id, f.agent.id);
  revisionListings = 0;
  assert.ok((await f.resolve(f.capture())).ready);
  assert.equal(revisionListings, 0, "the active execution needs no revision-history lookup");

  // Once its successor activates, the older installed execution must be refused.
  await f.activateRevision(f.namespace.id, f.agent.id, successor.id, f.revision.id);
  revisionListings = 0;
  assert.equal((await f.resolve(f.capture())).refused?.code, f.refusalCode("DENIED"));
  assert.equal(revisionListings, 1);
});

const currentCatalogCases = [
  "backend-generation",
  "backend-missing",
  "provider-generation",
  "provider-missing",
  "provider-source-type",
  "provider-model",
  "provider-login-mode",
] as const;

function changedCurrentCatalog(
  control: CredentialSourceControl,
  scenario: (typeof currentCatalogCases)[number],
  providerRef: CredentialSourceControl["providers"][number]["ref"],
) {
  const provider = control.providers.find((entry) => isDeepStrictEqual(entry.ref, providerRef));
  assert.ok(provider?.sourceType.harnessAuth);
  const replaceProvider = (changed: typeof provider) => ({
    ...control,
    providers: control.providers.map((entry) => (entry === provider ? changed : entry)),
  });
  // Only the currently installed catalog changes. Source, route, owner and admission stay fixed.
  switch (scenario) {
    case "backend-generation":
      return {
        ...control,
        backend: { ...control.backend, generation: control.backend.generation + 1 },
      };
    case "backend-missing":
      return { ...control, backend: undefined };
    case "provider-generation":
      return replaceProvider({
        ...provider,
        ref: { ...provider.ref, generation: provider.ref.generation + 1 },
      });
    case "provider-missing":
      return { ...control, providers: control.providers.filter((entry) => entry !== provider) };
    case "provider-source-type":
      return replaceProvider({
        ...provider,
        sourceType: { ...provider.sourceType, type: "other-source" },
      });
    case "provider-model":
      return replaceProvider({
        ...provider,
        sourceType: {
          ...provider.sourceType,
          harnessAuth: { ...provider.sourceType.harnessAuth, modelProvider: "other-model" },
        },
      });
    case "provider-login-mode":
      return replaceProvider({
        ...provider,
        sourceType: {
          ...provider.sourceType,
          harnessAuth: { ...provider.sourceType.harnessAuth, loginMode: "codex_pat" },
        },
      });
  }
}

function sourceWithNextGeneration(source: Readonly<CredentialSource>) {
  assert.ok(source.egress);
  return {
    ...source,
    egress: {
      ...source.egress,
      key: {
        ...source.egress.key,
        source: {
          ...source.egress.key.source,
          generation: source.egress.key.source.generation + 1,
        },
      },
    },
  };
}

// Controlled stored extension composition, not a public writer or built-in provider output.
// Grant unions and Harness catalog metadata are independent in the provider contract.
function withCompanionInference(
  t: TestContext,
  revision: AgentRevision,
  proxy: object,
): AgentRevision {
  // This extension advertises reduction support to admit multiple sources. No reduction
  // operation is exercised; the reader must decide before installation or policy effects.
  assert.equal("policyReduction" in proxy, false);
  Object.defineProperty(proxy, "policyReduction", {
    configurable: true,
    value: {
      version: 1,
      async apply() {
        assert.fail("reader must not apply a policy reduction");
      },
      async observe() {
        assert.fail("reader must not observe a policy reduction");
      },
    },
  });
  t.after(() => {
    Reflect.deleteProperty(proxy, "policyReduction");
  });
  const plan = revision.egressPlan;
  assert.ok(plan);
  const route = plan.routes[0];
  assert.ok(route?.binding.grant.kind === "inference");
  const grant = githubMetadataGrant({
    authority: "execution",
    app_id: "1",
    installation_id: "2",
    repository_id: "3",
    repository: "openclaw/fixture",
    agent_id: revision.agentId,
  });
  return {
    ...revision,
    egressPlan: {
      ...plan,
      policyReductionVersion: 1,
      routes: [
        {
          ...route,
          route: { ...route.route, id: route.route.id + "/metadata" },
          method: "GET",
          path: "/repos/openclaw/fixture",
          binding: {
            ...route.binding,
            binding: { ...route.binding.binding, id: route.binding.binding.id + "/metadata" },
            grant,
            grantHash: createHash("sha256").update(JSON.stringify(grant)).digest("hex"),
          },
        },
        {
          ...route,
          route: { ...route.route, id: route.route.id + "/companion" },
          binding: {
            ...route.binding,
            binding: { ...route.binding.binding, id: route.binding.binding.id + "/companion" },
            source: {
              ...route.binding.source,
              source: {
                ...route.binding.source.source,
                id: route.binding.source.source.id + "-companion",
              },
            },
          },
        },
      ],
    },
  };
}

// This is a private reader fixture. Public CREATE/deploy still emits Gateway snapshots.
// The controlled Kubernetes receiver stops execution at its first read; this proves the
// authentication gate on both public Compute operations, not workload readiness or enrollment.
async function kubernetesReaderFixture(t: TestContext) {
  const f = await staticEgressFixture(t, { recordInstallation: false });
  assert.ok("revision" in f);
  const gateway = f.controller.selectedDriver("credential_gateway");
  const compute = createTestKubernetesComputeDriver("proxy-reader-compute", {
    protectedDriver: f.installedDriver,
    credentialGatewayDriver: gateway,
    channelRuntime: true,
    modelProvider: { protocol: "openai-responses", baseUrl: f.modelProvider.baseUrl },
  });
  const storedSource = await f.controller.transact((unit: PlatformUnitOfWork) =>
    unit.credentialSources.findCredentialSource(f.namespace.id, f.source.id),
  );
  assert.ok(storedSource);
  // Public admission supplies all settings and routes; only Proxy ownership is synthetic.
  const proxyId = f.egress.id;
  function proxyFixture(admitted: AgentRevision, original: Readonly<CredentialSource>) {
    const source = {
      ...original,
      ownerCapability: "credential_proxy" as const,
      driverId: proxyId,
    };
    const auth = {
      method: "credential_source" as const,
      sourceId: source.id,
      sourceType: "openai" as const,
      credentialProxyId: proxyId,
      loginMode: "api_key" as const,
    };
    const admission = compute.admitRevision(admitted);
    assert.ok(admission);
    const revision: AgentRevision = {
      ...admitted,
      harnessAuth: auth,
      credentialSources: [
        { sourceId: source.id, sourceType: source.type, credentialProxyId: proxyId },
      ],
      compute: {
        id: compute.id,
        implementation: compute.implementation,
        admission,
      },
    };
    const context = {
      secretEnvironment: [],
      harnessAuth: { ...auth, source },
      currentEgressInstallation: async () => {
        assert.fail("the controlled first Kubernetes read must precede installation lookup");
      },
    };
    return { source, auth, revision, context };
  }
  const { source, auth, revision, context } = proxyFixture(f.revision, storedSource);
  const receiver = { reads: 0 };
  const reached = new Error("controlled Kubernetes receiver reached");
  const apiClients = Promise.resolve({
    core: {
      async listNamespace() {
        receiver.reads++;
        throw reached;
      },
    },
  });
  Object.assign(compute, { apiClients });
  const catalog = t.mock.method(gateway, "listSourceTypes", async () => {
    throw new Error("Proxy Harness must not read Gateway catalog");
  });
  return {
    f,
    gateway,
    compute,
    proxyFixture,
    source,
    auth,
    revision,
    context,
    receiver,
    reached,
    apiClients,
    catalog,
  };
}

type KubernetesReaderFixture = Awaited<ReturnType<typeof kubernetesReaderFixture>>;

async function checkCurrentCatalogAndAuth(t: TestContext, fixture: KubernetesReaderFixture) {
  const { f, compute, source, auth, revision, context, receiver, reached, catalog } = fixture;
  for (const operation of ["prepareRevision", "activateRevision"] as const) {
    await assert.rejects(compute[operation](revision, context), (error) => error === reached);
    assert.ok(receiver.reads > 0);
    assert.equal(catalog.mock.callCount(), 0);
    receiver.reads = 0;
    const admittedSource = structuredClone(source);
    const admittedPlan = structuredClone(revision.egressPlan);
    const current = f.egress.sourceControl;
    assert.ok(source.egress);
    assert.ok(
      revision.egressPlan?.routes.some((route) =>
        isDeepStrictEqual(route.binding.source, source.egress!.key),
      ),
    );
    for (const scenario of currentCatalogCases) {
      await t.test(`${operation}: ${scenario}`, async () => {
        Object.assign(f.egress, {
          sourceControl: changedCurrentCatalog(current, scenario, source.egress!.key.provider),
        });
        try {
          // Execution and route admission still pass; refusal must come from current catalog data.
          compute.validateExecutionAdmission(revision, "stored");
          assert.deepEqual(source, admittedSource);
          assert.deepEqual(revision.egressPlan, admittedPlan);
          await assert.rejects(
            compute[operation](revision, context),
            /matching supported OpenAI login mode/,
          );
          assert.equal(receiver.reads, 0, scenario);
        } finally {
          Object.assign(f.egress, { sourceControl: current });
        }
        // Restoration reaches the very same receiver with the very same admission.
        await assert.rejects(compute[operation](revision, context), (error) => error === reached);
        assert.ok(receiver.reads > 0);
        receiver.reads = 0;
      });
    }
    await t.test(`${operation}: source-route-generation`, async () => {
      // A new source generation leaves ownership and the current catalog unchanged.
      const changedSource = sourceWithNextGeneration(source);
      assert.deepEqual(changedSource.egress.key.backend, current.backend);
      assert.ok(
        current.providers.some((entry) =>
          isDeepStrictEqual(entry.ref, changedSource.egress.key.provider),
        ),
      );
      compute.validateExecutionAdmission(revision, "stored");
      await assert.rejects(
        compute[operation](revision, {
          ...context,
          harnessAuth: { ...auth, source: changedSource },
        }),
        /matching supported OpenAI login mode/,
      );
      assert.equal(
        receiver.reads,
        0,
        "a source outside the admitted route must not reach Kubernetes",
      );
      assert.deepEqual(f.egress.sourceControl, current);
      assert.deepEqual(revision.egressPlan, admittedPlan);
      await assert.rejects(compute[operation](revision, context), (error) => error === reached);
      assert.ok(receiver.reads > 0, "the admitted source still reaches the same receiver");
    });
    await checkHarnessAuthVariants(operation, fixture);
  }
}

async function checkHarnessAuthVariants(
  operation: "prepareRevision" | "activateRevision",
  fixture: Pick<
    KubernetesReaderFixture,
    "compute" | "source" | "auth" | "revision" | "context" | "receiver" | "gateway"
  >,
) {
  const { compute, source, auth, revision, context, receiver, gateway } = fixture;
  // Keep the next operation observable even when this subtest detects a regression.
  receiver.reads = 0;
  const withoutEgress = { ...source };
  delete withoutEgress.egress;
  for (const changedSource of [
    { ...source, driverId: "replacement-proxy" },
    { ...source, ownerCapability: "credential_gateway" as const },
    { ...source, state: "deleting" as const },
    withoutEgress,
  ]) {
    await assert.rejects(
      compute[operation](revision, {
        ...context,
        harnessAuth: { ...auth, source: changedSource },
      }),
      /matching supported OpenAI login mode/,
    );
    assert.equal(receiver.reads, 0);
  }
  for (const changedAuth of [
    { ...auth, credentialProxyId: "replacement-proxy" },
    { ...auth, credentialGatewayId: gateway.id },
    { ...auth, sourceType: "codex-pat" },
  ]) {
    await assert.rejects(
      compute[operation]({ ...revision, harnessAuth: changedAuth } as typeof revision, context),
      {
        message:
          "Credential-source Harness authentication requires paired Drivers and a matching supported OpenAI login mode.",
      },
    );
    assert.equal(receiver.reads, 0);
    // A correct stored snapshot cannot make a mismatched resolved context authoritative.
    await assert.rejects(
      compute[operation](revision, {
        ...context,
        harnessAuth: { ...changedAuth, source },
      } as typeof context),
      {
        message:
          "Credential-source Harness authentication requires paired Drivers and a matching supported OpenAI login mode.",
      },
    );
    assert.equal(receiver.reads, 0);
  }
  // This hostile snapshot retains API-key provider settings with a token login mode.
  // Saved-settings validation must refuse it before the owner/catalog decision.
  await assert.rejects(
    compute[operation](
      { ...revision, harnessAuth: { ...auth, loginMode: "codex_pat" } } as AgentRevision,
      context,
    ),
    { message: "Saved Harness settings are missing, malformed, or unsupported." },
  );
  assert.equal(receiver.reads, 0);
}

async function savedEndpointFixture(t: TestContext, fixture: KubernetesReaderFixture) {
  const { f, proxyFixture, catalog } = fixture;
  // Ordinary admission supplies normalized overrides, source consent and provider-derived routes.
  // Only ownership below is synthetic: public writers still emit Gateway-owned Harnesses.
  catalog.mock.restore();
  const root = `/namespaces/${f.namespace.id}`;
  const destination = f.modelProvider.baseUrl.replace("/v1", "/evaluation/v1");
  const post = async (path: string, body: unknown, status = 201) => {
    const result = await f.request("POST", root + path, { body });
    assert.equal(result.status, status, JSON.stringify(result.body));
    return result.data;
  };
  const alternate = await post("/credential-sources", {
    name: "reader-evaluation",
    type: "openai",
    config: { authorized_base_url: destination },
    secrets: f.source.secrets,
  });
  const agent = await post("/agents", {
    name: "reader-evaluation",
    configurationId: f.agent.configurationId,
    executionMode: "dedicated",
    harnessAuth: { method: "credential_source", sourceId: alternate.id },
    credentialSources: [{ sourceId: alternate.id }],
  });
  const role = await post("/iam/roles", {
    name: "reader-evaluation",
    permissions: [{ action: "operate", resourceKind: "credential_source" }],
  });
  await post("/iam/access-bindings", {
    subjectKind: "identity",
    subjectId: agent.servicePrincipalId,
    roleId: role.id,
    resourceKind: "credential_source",
    resourceId: alternate.id,
  });
  const admitted = await post(
    `/agents/${agent.id}/deploy`,
    {
      harnessOverrides: {
        modelProvider: { protocol: "openai-responses", baseUrl: destination + "/" },
      },
    },
    202,
  );
  const { saved, savedSource } = await f.controller.transact(async (unit: PlatformUnitOfWork) => ({
    saved: await unit.revisions.findRevision(f.namespace.id, agent.id, admitted.id),
    savedSource: await unit.credentialSources.findCredentialSource(f.namespace.id, alternate.id),
  }));
  assert.ok(saved?.egressPlan);
  assert.ok(savedSource?.egress);
  const {
    source: bSource,
    auth: bAuth,
    revision: b,
    context: bContext,
  } = proxyFixture(saved, savedSource);
  assert.deepEqual(b.harness.configuration, {
    modelProvider: {
      protocol: "openai-responses",
      baseUrl: destination,
      supportsStandaloneWebSearch: false,
    },
  });
  assert.ok(
    b.egressPlan?.routes.every(
      (route) =>
        route.origin + route.path === destination + "/responses" ||
        route.origin + route.path === destination + "/chat/completions",
    ),
  );
  return { source: bSource, auth: bAuth, revision: b, context: bContext };
}

function malformedDestinationPlans(plan: ProxyPlan) {
  const destinationCases = [
    [
      "adjacent pathname prefix",
      (route: ProxyPlan["routes"][number]) => ({
        ...route,
        path: route.path.replace("/evaluation/v1/", "/evaluation/v10/"),
      }),
    ],
    [
      "shifted origin pathname",
      (route: ProxyPlan["routes"][number]) => ({
        ...route,
        origin: route.origin + "/evaluation",
        path: route.path.replace("/evaluation", ""),
      }),
    ],
    [
      "query in pathname",
      (route: ProxyPlan["routes"][number]) => ({
        ...route,
        path: route.path + "?ignored=1",
      }),
    ],
    [
      "fragment in pathname",
      (route: ProxyPlan["routes"][number]) => ({
        ...route,
        path: route.path + "#ignored",
      }),
    ],
    [
      "rewritten pathname",
      (route: ProxyPlan["routes"][number]) => ({
        ...route,
        path: route.path.replace("/v1/", "/v1/./"),
      }),
    ],
  ] as const;
  return destinationCases.map(
    ([name, change]) => [name, { ...plan, routes: plan.routes.map(change) }] as const,
  );
}

async function checkSavedDestinations(
  t: TestContext,
  fixture: KubernetesReaderFixture,
  saved: Awaited<ReturnType<typeof savedEndpointFixture>>,
) {
  const { f, gateway, compute, source, revision, apiClients, receiver, reached } = fixture;
  const { source: bSource, auth: bAuth, revision: b, context: bContext } = saved;
  // A new Compute instance has a third default; it must honor the admitted endpoint.
  const restarted = createTestKubernetesComputeDriver(compute.id, {
    protectedDriver: f.installedDriver,
    credentialGatewayDriver: gateway,
    channelRuntime: true,
    modelProvider: { protocol: "openai-responses", baseUrl: "https://changed.example.test/v1" },
  });
  Object.assign(restarted, { apiClients });
  const current = f.egress.sourceControl;
  assert.ok(bSource.egress);
  const providerRef = bSource.egress.key.provider;
  const provider = current.providers.find((entry) => isDeepStrictEqual(entry.ref, providerRef));
  assert.ok(provider);
  // Hostile stored composition, not normal admission: old endpoint routes with B's binding.
  const stale = {
    ...b,
    egressPlan: {
      ...b.egressPlan!,
      routes: provider.routes(
        { ...bSource, config: source.config },
        b.egressPlan!.routes[0]!.binding,
        revision.harness.configuration,
      ),
    },
  };
  const malformedDestinations = malformedDestinationPlans(b.egressPlan!).map(
    ([name, egressPlan]) => [name, { ...b, egressPlan }] as const,
  );
  const mixed = withCompanionInference(t, b, f.egress);
  const restartedCatalog = t.mock.method(gateway, "listSourceTypes", async () => {
    throw new Error("Proxy Harness must not read Gateway catalog");
  });
  for (const operation of ["prepareRevision", "activateRevision"] as const) {
    receiver.reads = 0;
    await assert.rejects(restarted[operation](b, bContext), (error) => error === reached);
    assert.ok(receiver.reads > 0);
    assert.equal(restartedCatalog.mock.callCount(), 0);
    assert.doesNotThrow(() => restarted["validateRevisionExecution"](b, bContext));
    await t.test(`${operation}: wrong source consent`, async () => {
      receiver.reads = 0;
      await assert.rejects(
        restarted[operation](b, {
          ...bContext,
          harnessAuth: { ...bAuth, source: { ...bSource, config: source.config } },
        }),
        {
          name: "StoredCredentialSourceConfigError",
          field: "authorized_base_url",
        },
      );
      assert.equal(receiver.reads, 0);
    });
    for (const [name, invalid] of [
      ["stale route destination", stale],
      ...malformedDestinations,
    ] as const) {
      await t.test(`${operation}: ${name}`, async () => {
        receiver.reads = 0;
        assert.doesNotThrow(() => restarted["validateRevisionExecution"](invalid, bContext));
        await assert.rejects(restarted[operation](invalid, bContext), {
          message:
            "The admitted Harness route destination does not match its saved model endpoint.",
        });
        assert.equal(receiver.reads, 0);
      });
    }
    await t.test(
      `${operation}: companion inference cannot serve the selected Harness source`,
      async () => {
        receiver.reads = 0;
        // The plan-wide inference/release gate accepts this shape. Only the selected-source
        // reader can distinguish its non-inference binding from the companion's inference.
        assert.doesNotThrow(() => restarted["validateRevisionExecution"](mixed, bContext));
        await assert.rejects(restarted[operation](mixed, bContext), {
          message:
            "Credential-source Harness authentication requires paired Drivers and a matching supported OpenAI login mode.",
        });
        assert.equal(receiver.reads, 0);
      },
    );
    await t.test(
      `${operation}: catalog shape does not authorize route callback replay`,
      async () => {
        let callbacks = 0;
        const custom = {
          ...provider,
          routes() {
            callbacks++;
            throw new Error("admission-only route callback must not run during execution");
          },
        };
        Object.assign(f.egress, {
          sourceControl: {
            ...current,
            providers: current.providers.map((entry) => (entry === provider ? custom : entry)),
          },
        });
        try {
          receiver.reads = 0;
          // Retain one valid route: destination checking must not restore or require removed routes.
          const reduced = {
            ...b,
            egressPlan: { ...b.egressPlan!, routes: b.egressPlan!.routes.slice(0, 1) },
          };
          assert.doesNotThrow(() => restarted["validateRevisionExecution"](reduced, bContext));
          await assert.rejects(
            restarted[operation](reduced, bContext),
            (error) => error === reached,
          );
          assert.equal(callbacks, 0);
          assert.ok(receiver.reads > 0);
        } finally {
          Object.assign(f.egress, { sourceControl: current });
        }
      },
    );
  }
}

test("Kubernetes reads a synthetic Proxy Harness through its pinned catalog before external effects", async (t) => {
  const fixture = await kubernetesReaderFixture(t);
  await checkCurrentCatalogAndAuth(t, fixture);
  const saved = await savedEndpointFixture(t, fixture);
  await checkSavedDestinations(t, fixture, saved);
});

async function storedProxyHarnessFixture(t: TestContext, mismatchedOwner = false) {
  let app!: Awaited<ReturnType<typeof postgresApp>>;
  const legacy = await staticEgressFixture(t, {
    recordInstallation: false,
    appFactory: async (context: TestContext, options: object = {}) => {
      app = await postgresApp(context, options);
      return app as unknown as Awaited<ReturnType<typeof createConsoleAppFixture>>;
    },
  });
  assert.ok("revision" in legacy);
  const created = await app.request("POST", `/namespaces/${legacy.namespace.id}/agents`, {
    body: {
      name: "proxy-reader-dispatch",
      configurationId: legacy.agent.configurationId,
      executionMode: "dedicated",
      harnessAuth: { method: "runtime" },
    },
  });
  assert.equal(created.status, 201);
  const f = { ...legacy, agent: created.data };
  const compute = createTestKubernetesComputeDriver("stored-proxy-reader", {
    protectedDriver: f.installedDriver,
    credentialGatewayDriver: f.controller.selectedDriver("credential_gateway"),
    channelRuntime: true,
    modelProvider: { protocol: "openai-responses", baseUrl: f.modelProvider.baseUrl },
  });
  const oldSource = await app.state.read((view) =>
    view.credentialSources.findCredentialSource(f.namespace.id, f.source.id),
  );
  assert.ok(oldSource?.egress);
  const sourceOwnerId = mismatchedOwner ? `${f.egress.id}-previous` : f.egress.id;
  const sourceId = `cs_${randomUUID()}`;
  const revisionId = `rev_${randomUUID()}`;
  // This explicitly seeds private reader data. It does not enable or prove public CREATE.
  const source = {
    ...oldSource,
    id: sourceId,
    name: "synthetic-proxy-reader",
    ownerCapability: "credential_proxy" as const,
    driverId: sourceOwnerId,
    egress: {
      ...oldSource.egress,
      key: { ...oldSource.egress.key, source: { ...oldSource.egress.key.source, id: sourceId } },
    },
  };
  const auth = {
    method: "credential_source" as const,
    sourceId,
    credentialProxyId: sourceOwnerId,
    sourceType: "openai" as const,
    loginMode: "api_key" as const,
  };
  const identities = new Map([
    [f.egress.id, sourceOwnerId],
    [oldSource.id, sourceId],
    [f.revision.id, revisionId],
    [legacy.agent.id, f.agent.id],
    [legacy.agent.servicePrincipalId, f.agent.servicePrincipalId],
  ]);
  const revision: AgentRevision = {
    ...f.revision,
    id: revisionId,
    revision: 1,
    agentId: f.agent.id,
    servicePrincipalId: f.agent.servicePrincipalId,
    harnessAuth: auth,
    credentialSources: [{ sourceId, sourceType: "openai", credentialProxyId: sourceOwnerId }],
    egressPlan: JSON.parse(
      JSON.stringify(f.revision.egressPlan, (_key, value) =>
        typeof value === "string" ? (identities.get(value) ?? value) : value,
      ),
    ),
    compute: {
      id: compute.id,
      implementation: compute.implementation,
      admission: compute.admitRevision(f.revision),
    },
  };
  await app.state.transact(async (unit) => {
    await unit.credentialSources.createCredentialSource(source);
    await unit.agents.updateConfiguration(
      f.namespace.id,
      f.agent.id,
      f.agent.configurationId,
      undefined,
      { method: "credential_source", sourceId },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [{ sourceId }],
    );
    await unit.revisions.createRevision(revision);
  });
  const role = await app.request("POST", `/namespaces/${f.namespace.id}/iam/roles`, {
    body: {
      name: "proxy-reader-use",
      permissions: [{ action: "operate", resourceKind: "credential_source" }],
    },
  });
  assert.equal(role.status, 201);
  const grant = await app.request("POST", `/namespaces/${f.namespace.id}/iam/access-bindings`, {
    body: {
      subjectKind: "identity",
      subjectId: f.agent.servicePrincipalId,
      roleId: role.data.id,
      resourceKind: "credential_source",
      resourceId: sourceId,
    },
  });
  assert.equal(grant.status, 201);

  return { app, f, legacy, compute, source, sourceId, auth, revision, revisionId, grant };
}

test(
  "Worker reads a stored synthetic Proxy Harness and refuses revoked or withdrawn authority",
  requiresPostgres,
  async (t) => {
    const { app, f, compute, source, sourceId, auth, revisionId, grant } =
      await storedProxyHarnessFixture(t);
    const worker = new ControllerWorker({
      pool: app.pool,
      computeDriver: compute,
      sandboxDriver: f.sandboxDriver,
      proxyDriver: f.egress,
      emit() {},
    });
    const stored = await app.state.read((view) =>
      view.revisions.findRevision(f.namespace.id, f.agent.id, revisionId),
    );
    assert.ok(stored);
    // Initialize the durable Installation as start() does, without launching its background loop.
    Object.assign(worker, { installation: await app.state.loadInstallation() });
    const claim = { actorId: app.principal.id } as ClaimedWork;
    assert.equal(await worker["authorizeRevision"](claim, f.agent, stored), undefined);
    const resolved = await worker["resolveRevisionSecretContext"](stored);
    assert.ok("context" in resolved);
    assert.equal(resolved.context.harnessAuth?.method, "credential_source");
    assert.deepEqual(resolved.context.harnessAuth, { ...auth, source });
    const mixed = withCompanionInference(t, stored, f.egress);
    assert.doesNotThrow(() => worker["validateExecutionAdmission"](mixed));
    assert.doesNotThrow(() => compute["validateRevisionExecution"](mixed, resolved.context));
    const catalogDescriptor = Object.getOwnPropertyDescriptor(f.egress, "sourceControl");
    let catalogReads = 0;
    // A plan without this source's inference route must refuse before any catalog access.
    Object.defineProperty(f.egress, "sourceControl", {
      configurable: true,
      get() {
        catalogReads++;
        throw new Error("A missing retained inference route must not consult the Proxy catalog.");
      },
    });
    try {
      assert.deepEqual(await worker["resolveRevisionSecretContext"](mixed), {
        result: { outcome: "permanent", code: "EGRESS_PROVIDER_UNAVAILABLE" },
      });
      assert.equal(catalogReads, 0);
    } finally {
      if (catalogDescriptor === undefined) {
        Reflect.deleteProperty(f.egress, "sourceControl");
      } else {
        Object.defineProperty(f.egress, "sourceControl", catalogDescriptor);
      }
    }
    for (const wrongAuth of [
      { ...auth, credentialProxyId: "wrong-proxy" },
      { ...auth, credentialGatewayId: "wrong-gateway" },
      { ...auth, sourceType: "codex-pat" },
      { ...auth, loginMode: "codex_pat" },
    ]) {
      const result: Awaited<ReturnType<ControllerWorker["resolveRevisionSecretContext"]>> =
        await worker["resolveRevisionSecretContext"]({
          ...stored,
          harnessAuth: wrongAuth,
        } as AgentRevision);
      assert.ok("result" in result);
      assert.equal(result.result.outcome, "permanent");
    }
    assert.equal(
      (
        await app.request(
          "DELETE",
          `/namespaces/${f.namespace.id}/iam/access-bindings/${grant.data.id}`,
        )
      ).status,
      204,
    );
    assert.equal(
      (await worker["authorizeRevision"](claim, f.agent, stored))?.code,
      "AUTHORIZATION_DENIED",
    );
    await app.state.transact((unit) =>
      unit.credentialSources.requestCredentialWithdrawal({
        namespaceId: stored.namespaceId,
        agentId: stored.agentId,
        revisionId: stored.id,
        credentialSourceId: sourceId,
        requestedBy: app.principal.id,
        requestedAt: new Date().toISOString(),
        state: "pending",
      }),
    );
    const withdrawn = await worker["resolveRevisionSecretContext"](stored);
    assert.ok("result" in withdrawn);
    assert.equal(withdrawn.result.code, "CREDENTIAL_WITHDRAWN");
    // A fresh Worker reads durable withdrawal rather than reattaching the archived source.
    const restarted = new ControllerWorker({
      pool: app.pool,
      computeDriver: compute,
      sandboxDriver: f.sandboxDriver,
      proxyDriver: f.egress,
      emit() {},
    });
    assert.deepEqual(await restarted["resolveRevisionSecretContext"](stored), withdrawn);
  },
);

type StoredProxyHarnessFixture = Awaited<ReturnType<typeof storedProxyHarnessFixture>>;
type DispatchAuthority =
  | "current"
  | "revoked"
  | "mismatched-owner"
  | "withdrawn"
  | "source-route-generation"
  | (typeof currentCatalogCases)[number];

// Expected refusals describe the authority boundary, independently of Worker implementation.
const claimedDispatchCases = [
  { authority: "current", expectedRefusal: undefined },
  { authority: "revoked", expectedRefusal: "AUTHORIZATION_DENIED" },
  { authority: "mismatched-owner", expectedRefusal: "EXECUTION_ADMISSION_UNAVAILABLE" },
  { authority: "withdrawn", expectedRefusal: "CREDENTIAL_WITHDRAWN" },
  { authority: "source-route-generation", expectedRefusal: "EGRESS_PROVIDER_UNAVAILABLE" },
  { authority: "backend-generation", expectedRefusal: "EGRESS_PROVIDER_UNAVAILABLE" },
  { authority: "backend-missing", expectedRefusal: "EGRESS_PROVIDER_UNAVAILABLE" },
  { authority: "provider-generation", expectedRefusal: "EGRESS_PROVIDER_UNAVAILABLE" },
  { authority: "provider-missing", expectedRefusal: "EGRESS_PROVIDER_UNAVAILABLE" },
  { authority: "provider-source-type", expectedRefusal: "EGRESS_PROVIDER_UNAVAILABLE" },
  { authority: "provider-model", expectedRefusal: "EGRESS_PROVIDER_UNAVAILABLE" },
  { authority: "provider-login-mode", expectedRefusal: "EGRESS_PROVIDER_UNAVAILABLE" },
] as const satisfies readonly {
  authority: DispatchAuthority;
  expectedRefusal: string | undefined;
}[];

async function advanceDispatchSourceGeneration(fixture: StoredProxyHarnessFixture) {
  const { app, f, compute, sourceId, revision } = fixture;
  const original = await app.state.read((view) =>
    view.credentialSources.findCredentialSource(revision.namespaceId, sourceId),
  );
  assert.ok(original?.egress);
  const changed = sourceWithNextGeneration(original);
  const current = f.egress.sourceControl;
  const admittedRevision = await app.state.read((view) =>
    view.revisions.findRevision(revision.namespaceId, revision.agentId, revision.id),
  );
  assert.deepEqual(changed.egress.key.backend, current.backend);
  assert.ok(
    current.providers.some((entry) => isDeepStrictEqual(entry.ref, changed.egress.key.provider)),
  );
  assert.ok(
    revision.egressPlan?.routes.some((route) =>
      isDeepStrictEqual(route.binding.source, original.egress!.key),
    ),
  );
  const saved = await app.state.transact((unit) =>
    unit.credentialSources.admitEgressSource(
      revision.namespaceId,
      sourceId,
      original.egress!.key.source.generation,
      changed.egress,
    ),
  );
  assert.deepEqual(saved, changed);
  assert.deepEqual(f.egress.sourceControl, current);
  assert.deepEqual(
    await app.state.read((view) =>
      view.revisions.findRevision(revision.namespaceId, revision.agentId, revision.id),
    ),
    admittedRevision,
  );
  compute.validateExecutionAdmission(revision, "stored");
}

async function changeDispatchCatalog(
  t: TestContext,
  fixture: StoredProxyHarnessFixture,
  catalogScenario: (typeof currentCatalogCases)[number],
) {
  const { app, f, compute, sourceId, revision } = fixture;
  const savedSource = await app.state.read((view) =>
    view.credentialSources.findCredentialSource(revision.namespaceId, sourceId),
  );
  assert.ok(savedSource?.egress);
  assert.ok(
    revision.egressPlan?.routes.some((route) =>
      isDeepStrictEqual(route.binding.source, savedSource.egress!.key),
    ),
  );
  const savedRevision = await app.state.read((view) =>
    view.revisions.findRevision(revision.namespaceId, revision.agentId, revision.id),
  );
  const current = f.egress.sourceControl;
  Object.assign(f.egress, {
    sourceControl: changedCurrentCatalog(current, catalogScenario, savedSource.egress.key.provider),
  });
  t.after(() => {
    Object.assign(f.egress, { sourceControl: current });
  });
  compute.validateExecutionAdmission(revision, "stored");
  assert.deepEqual(
    await app.state.read((view) =>
      view.credentialSources.findCredentialSource(revision.namespaceId, sourceId),
    ),
    savedSource,
  );
  assert.deepEqual(
    await app.state.read((view) =>
      view.revisions.findRevision(revision.namespaceId, revision.agentId, revision.id),
    ),
    savedRevision,
  );
}

async function arrangeDispatchAuthority(
  t: TestContext,
  fixture: StoredProxyHarnessFixture,
  authority: DispatchAuthority,
) {
  const { app, f, sourceId, revision, grant } = fixture;
  switch (authority) {
    case "current":
    case "mismatched-owner":
      // The saved fixture already has this owner; leave its source and catalog unchanged.
      return;
    case "revoked":
      assert.equal(
        (
          await app.request(
            "DELETE",
            `/namespaces/${f.namespace.id}/iam/access-bindings/${grant.data.id}`,
          )
        ).status,
        204,
      );
      return;
    case "withdrawn":
      await app.state.transact((unit) =>
        unit.credentialSources.requestCredentialWithdrawal({
          namespaceId: revision.namespaceId,
          agentId: revision.agentId,
          revisionId: revision.id,
          credentialSourceId: sourceId,
          requestedBy: app.principal.id,
          requestedAt: new Date().toISOString(),
          state: "pending",
        }),
      );
      return;
    case "source-route-generation":
      await advanceDispatchSourceGeneration(fixture);
      return;
    default:
      await changeDispatchCatalog(t, fixture, authority);
  }
}

function observeDispatchEffects(t: TestContext, compute: StoredProxyHarnessFixture["compute"]) {
  const observation = {
    receiverCalls: 0,
    invocations: { prepareRevision: 0, activateRevision: 0 },
  };
  let freshOperation = false;
  const { invocations } = observation;
  // Pass-through observers retain the real Compute implementation. Cleanup may read
  // Kubernetes after refusal; those reads are not fresh preparation or activation.
  async function observe<Result>(method: keyof typeof invocations, work: () => Promise<Result>) {
    invocations[method]++;
    freshOperation = true;
    try {
      return await work();
    } finally {
      freshOperation = false;
    }
  }
  const prepare = compute.prepareRevision.bind(compute);
  const activate = compute.activateRevision.bind(compute);
  t.mock.method(compute, "prepareRevision", (...args: Parameters<typeof prepare>) =>
    observe("prepareRevision", () => prepare(...args)),
  );
  t.mock.method(compute, "activateRevision", (...args: Parameters<typeof activate>) =>
    observe("activateRevision", () => activate(...args)),
  );
  const absent = async () => {
    throw Object.assign(new Error("Not found"), { code: 404 });
  };
  Object.assign(compute, {
    apiClients: Promise.resolve({
      core: {
        async listNamespace() {
          if (freshOperation) {
            observation.receiverCalls++;
            throw new Error("controlled Kubernetes dispatch receiver");
          }
          return { items: [] };
        },
        readNamespace: absent,
        readNamespacedService: absent,
        readNamespacedSecret: absent,
        readNamespacedServiceAccount: absent,
        readNamespacedConfigMap: absent,
        readNamespacedPersistentVolumeClaim: absent,
        listNamespacedPod: async () => ({ items: [] }),
      },
      apps: { readNamespacedDeployment: absent },
      networking: { readNamespacedNetworkPolicy: absent },
      objects: { read: absent },
    }),
  });
  return observation;
}

async function processClaimedRevision(fixture: StoredProxyHarnessFixture) {
  const { app, f, compute, revision } = fixture;
  // Constructed after withdrawal commits: the new Worker must read durable authority.
  const worker = new ControllerWorker({
    pool: app.pool,
    computeDriver: compute,
    sandboxDriver: f.sandboxDriver,
    proxyDriver: f.egress,
    emit() {},
  });
  Object.assign(worker, { installation: await app.state.loadInstallation() });
  // Synthetic writer boundary: use the same desired-state transition as deploy,
  // without publishing an active revision or claiming that a runtime exists.
  await app.state.transact(async (unit) => {
    assert.ok(
      await unit.agents.transitionAgentDesiredRuntimeState(
        revision.namespaceId,
        revision.agentId,
        "stopped",
        "running",
      ),
    );
  });
  const queue = worker["queue"];
  const key = `agent_revision:${revision.id}:reconcile`;
  await queue.enqueue({
    idempotencyKey: key,
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    revisionId: revision.id,
    actorId: app.principal.id,
  });
  // Other fixture namespaces have queued lifecycle work. Hold their rows while the
  // production SKIP LOCKED claim selects this scenario; do not rewrite queue outcomes.
  const scheduling = await app.pool.connect();
  let claimed;
  try {
    await scheduling.query("BEGIN");
    await scheduling.query(
      "SELECT idempotency_key FROM occ.controller_work WHERE idempotency_key <> $1 FOR UPDATE",
      [key],
    );
    claimed = await queue.claim();
  } finally {
    await scheduling.query("ROLLBACK");
    scheduling.release();
  }
  assert.ok(claimed);
  assert.equal(claimed.idempotencyKey, key);
  await worker["process"](claimed);
  const finished = await queue.findWork(key);
  assert.ok(finished);
  assert.notEqual(finished.state, "claimed", "the production dispatch settles its real lease");
  return finished;
}

// Synthetic B starts at storage: CREATE/deploy emission is deliberately not under test.
// Claiming the durable queue and entering process() exercises the same dispatch used by run().
test(
  "claimed Worker dispatch gates a stored Proxy Harness before Kubernetes effects",
  requiresPostgres,
  async (t) => {
    for (const { authority, expectedRefusal } of claimedDispatchCases) {
      await t.test(authority, async (t) => {
        const fixture = await storedProxyHarnessFixture(t, authority === "mismatched-owner");
        const { app, f, compute, revision } = fixture;
        await arrangeDispatchAuthority(t, fixture, authority);
        const observation = observeDispatchEffects(t, compute);
        const finished = await processClaimedRevision(fixture);
        const { receiverCalls, invocations } = observation;
        if (authority === "current") {
          assert.ok(receiverCalls > 0, JSON.stringify(finished));
          assert.equal(invocations.prepareRevision, 1);
          assert.equal(invocations.activateRevision, 0);
        } else {
          assert.equal(
            receiverCalls,
            0,
            "refused authority must not reach prepare/activate receivers",
          );
          assert.deepEqual(invocations, { prepareRevision: 0, activateRevision: 0 });
          assert.equal(finished.reasonCode, expectedRefusal);
        }
        assert.equal(
          f.observed.deleted.length,
          0,
          "no existing Sandbox is retired by this new Agent's dispatch",
        );
        assert.equal(
          (
            await app.state.read((view) =>
              view.agents.findAgent(revision.namespaceId, revision.agentId),
            )
          )?.activeRevisionId,
          undefined,
        );
      });
    }
  },
);

test(
  "archived Gateway revision retires through its original Sandbox after source deletion",
  requiresPostgres,
  async (t) => {
    const { app, f, legacy, compute, sourceId, revision: b } = await storedProxyHarnessFixture(t);
    // Populate historical A from the ordinary Gateway admission, recording its Compute
    // before insertion. This archive fixture does not claim a live A activation.
    const aId = `rev_${randomUUID()}`;
    const aInput: AgentRevision = {
      ...legacy.revision,
      id: aId,
      revision: 2,
      compute: {
        id: compute.id,
        implementation: compute.implementation,
        admission: compute.admitRevision(legacy.revision),
      },
      egressPlan: JSON.parse(
        JSON.stringify(legacy.revision.egressPlan, (_key, value) =>
          value === legacy.revision.id ? aId : value,
        ),
      ),
    };
    const a = await app.state.transact((unit) => unit.revisions.createRevision(aInput));
    assert.equal(a.harnessAuth.method, "credential_source");
    assert.equal(
      a.harnessAuth.credentialGatewayId,
      app.controller.selectedDriver("credential_gateway").id,
    );
    assert.equal(a.compute.id, compute.id);
    const bytes = async () =>
      (
        await app.pool.query(
          "SELECT jsonb_send(admitted_spec) AS bytes FROM occ.agent_revisions WHERE id=$1",
          [a.id],
        )
      ).rows[0].bytes;
    const before = await bytes();
    // Move only the live draft to B. No active pointer is changed or runtime activation claimed.
    await app.state.transact(async (unit) => {
      await unit.agents.updateConfiguration(
        a.namespaceId,
        a.agentId,
        legacy.agent.configurationId,
        undefined,
        { method: "credential_source", sourceId },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [{ sourceId }],
      );
      assert.equal(
        await unit.credentialSources.deleteCredentialSource(a.namespaceId, legacy.source.id),
        true,
      );
    });
    const fresh = new PostgresPlatformState(app.pool);
    const archived = await fresh.read((view) =>
      view.revisions.findRevision(a.namespaceId, a.agentId, a.id),
    );
    assert.deepEqual(archived, a);
    assert.deepEqual(await bytes(), before);
    assert.equal(
      await fresh.read((view) =>
        view.credentialSources.findCredentialSource(a.namespaceId, legacy.source.id),
      ),
      undefined,
    );
    const bBefore = await fresh.read((view) =>
      view.revisions.findRevision(b.namespaceId, b.agentId, b.id),
    );
    const currentBefore = await fresh.read((view) =>
      view.agents.findAgent(a.namespaceId, a.agentId),
    );
    assert.deepEqual(currentBefore?.harnessAuth, { method: "credential_source", sourceId });
    const cleanups: AgentRevision[] = [];
    let refuse = true;
    // This is the Sandbox cleanup receiver, as in Kubernetes' existing retirement conformance.
    // Compute remains real; receiver failure must propagate and an explicit retry repeats A.
    const sandbox = {
      id: f.sandboxDriver.id,
      implementation: f.sandboxDriver.implementation,
      capability: "sandbox" as const,
      facets: f.sandboxDriver.facets,
      supportsHarnessExecutionMode: f.sandboxDriver.supportsHarnessExecutionMode,
      async provisionHarness() {
        assert.fail("retirement must not provision a Harness");
      },
      async cleanup(context: { revision?: Readonly<AgentRevision> }) {
        assert.deepEqual(context.revision, a);
        cleanups.push(structuredClone(context.revision!));
        if (refuse) {
          refuse = false;
          throw new Error("controlled Sandbox cleanup unavailable");
        }
      },
    };
    const retiring = createTestKubernetesComputeDriver(compute.id, { sandboxDriver: sandbox });
    const namespace = kubernetesNamespaceName(a.namespaceId);
    const namespaceResource = {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: namespace,
        labels: {
          "app.kubernetes.io/managed-by": "openclaw-enterprise",
          "openclaw.dev/namespace": a.namespaceId,
        },
        annotations: { "openclaw.dev/namespace-id": a.namespaceId },
      },
    };
    const absent = async () => {
      throw Object.assign(new Error("Not found"), { code: 404 });
    };
    let podReads = 0;
    Object.assign(retiring, {
      apiClients: Promise.resolve({
        core: {
          listNamespace: async () => ({ items: [namespaceResource] }),
          readNamespace: async ({ name }: { name: string }) =>
            name === namespace ? namespaceResource : absent(),
          readNamespacedSecret: absent,
          readNamespacedService: absent,
          readNamespacedServiceAccount: absent,
          readNamespacedPersistentVolumeClaim: absent,
          readNamespacedConfigMap: absent,
          listNamespacedPod: async () => {
            podReads++;
            return { items: [] };
          },
        },
        apps: { readNamespacedDeployment: absent },
        networking: { readNamespacedNetworkPolicy: absent },
        objects: { read: absent },
      }),
    });
    assert.ok(archived);
    await assert.rejects(
      retiring.retireRevision(archived),
      /controlled Sandbox cleanup unavailable/,
    );
    assert.equal(podReads, 0, "uncertain cleanup must not be reported as successful retirement");
    await retiring.retireRevision(archived);
    assert.equal(cleanups.length, 2);
    assert.deepEqual(
      await fresh.read((view) => view.agents.findAgent(a.namespaceId, a.agentId)),
      currentBefore,
    );
    assert.ok(podReads > 0);
    assert.deepEqual(
      await fresh.read((view) => view.revisions.findRevision(b.namespaceId, b.agentId, b.id)),
      bBefore,
    );
    assert.ok(
      await fresh.read((view) =>
        view.credentialSources.findCredentialSource(b.namespaceId, sourceId),
      ),
    );
    assert.deepEqual(await bytes(), before);
  },
);

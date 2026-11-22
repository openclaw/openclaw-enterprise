import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, type TestContext } from "node:test";
import type {
  ComputeDriver,
  CredentialProxyDriver,
  DeploymentCredentialBinding,
  Namespace,
  ResolvedCredential,
} from "../../packages/contracts/src/index.ts";
import {
  OpenClawController,
  CredentialDeploymentFailedError,
  ResourceStateConflictError,
} from "../../packages/occ/src/index.ts";
import { installationControllerOptions } from "../../apps/controller/src/composition/installation-config.ts";
import { installSelectedSandboxDrivers } from "../../apps/controller/src/composition/sandbox-drivers.ts";
import { installTokenServiceDriver } from "../../apps/controller/src/composition/token-service.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import {
  MANAGED_BY,
  MANAGED_BY_LABEL,
  createOpenShellBackend,
  openShellProviderName,
} from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellCredentialProxyDriver } from "../../apps/controller/src/drivers/credential-proxy/openshell.ts";
import { prepareOccTokenServiceProviderCopy } from "../../apps/controller/src/drivers/credential-proxy/openshell-pushed-provider.ts";
import type {
  OpenShellGatewayClient,
  OpenShellProviderCreateRequest,
  OpenShellProviderResponse,
  OpenShellSandboxProviderStatus,
  OpenShellStoredProviderProfile,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.ts";
import { completeOpenShellGatewayClient } from "../helpers/openshell-gateway-client.ts";
import { createPostgresControllerAuth } from "../helpers/password-hasher.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import type { RevisionFixture } from "../helpers/postgres-worker-refused-candidate.ts";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import { useInstallationSecretDriver } from "../helpers/kubernetes-secret-core.mjs";
import { auditEvent } from "./postgres-namespace-iam-fixture.ts";
import { buildSandboxInstallation } from "./sandbox-driver-installation-fixture.ts";
import {
  createCredentialSourceRevisionCases,
  removeSourceGrant,
} from "./postgres-worker-credential-scenarios.ts";
import { registerWithdrawalCases } from "./postgres-worker-withdrawal-cases.ts";
import { registerDeploymentWithdrawalCases } from "./postgres-worker-deployment-withdrawal-cases.ts";
import { registerWithdrawalMaintenanceCases } from "./postgres-worker-withdrawal-maintenance-cases.ts";
import { registerFiniteGitCases } from "./postgres-worker-finite-git-cases.ts";

// The lane prepares one migrated template for this entry. Every case clones it
// through the shared fixture and the process owns its teardown backstop.
const cases = createCredentialSourceRevisionCases(import.meta.url);
after(cases.cleanup);

registerWithdrawalCases(cases);
registerDeploymentWithdrawalCases(cases);
registerWithdrawalMaintenanceCases(cases);
registerFiniteGitCases(import.meta.url);

function recordingActiveGateway(
  namespaceId: string,
  workspace: string,
  sandboxId: string,
  sourceId: string,
) {
  const sandboxName = "active-source-sandbox";
  const providerName = openShellProviderName(sourceId);
  const workspaceId = randomUUID();
  const attachmentEpoch = randomUUID();
  const networkInstanceId = randomUUID();
  const policyHash = "a".repeat(64);
  const updates: OpenShellProviderCreateRequest[] = [];
  const receiptReads: string[] = [];
  let profile: OpenShellStoredProviderProfile | undefined;
  let provider: OpenShellProviderResponse | undefined;
  let status: OpenShellSandboxProviderStatus | undefined;
  const sandbox = {
    id: sandboxId,
    name: sandboxName,
    workspace,
    labels: {},
    annotations: {},
    serviceUrls: {},
    spec: { providers: [] as string[], provider_attachment_epoch: attachmentEpoch },
    configurationActivated: true,
    configurationAdmission: {
      state: 2,
      provider_env_revision: "2",
      config_revision: "2",
      policy_hash: policyHash,
    },
    mainProcessInstanceId: networkInstanceId,
  };
  const client = {
    async getWorkspace(name) {
      assert.equal(name, workspace);
      return {
        id: workspaceId,
        name: workspace,
        labels: { [MANAGED_BY_LABEL]: MANAGED_BY, "openclaw.dev/namespace-id": namespaceId },
      };
    },
    async getProviderProfile(requestWorkspace, id) {
      assert.equal(requestWorkspace, workspace);
      assert.equal(id, providerName);
      return profile;
    },
    async importProviderProfile(requestWorkspace, supplied) {
      assert.equal(requestWorkspace, workspace);
      assert.equal(supplied.id, providerName);
      profile = {
        id: supplied.id,
        resourceVersion: "1",
        annotations: supplied.annotations,
        definition: {
          credentials: supplied.credentials.map((credential) => ({
            name: credential.name,
            env_vars: credential.envVars,
            required: credential.required,
            auth_style: credential.authStyle,
            header_name: credential.headerName,
            stable_placeholder: credential.stablePlaceholder,
          })),
        },
      };
    },
    async getProvider(requestWorkspace, name) {
      assert.equal(requestWorkspace, workspace);
      assert.equal(name, providerName);
      return provider;
    },
    async createProvider(request) {
      assert.equal(request.workspace, workspace);
      assert.equal(request.name, providerName);
      assert.equal(request.type, providerName);
      provider = {
        id: randomUUID(),
        workspace,
        profileWorkspace: workspace,
        name: request.name,
        type: request.type,
        labels: request.labels,
        config: request.config ?? {},
        resourceVersion: "1",
      };
      return provider;
    },
    async updateProviderCredentialsConditionally(request, expectedVersion) {
      assert.ok(provider);
      assert.equal(request.workspace, workspace);
      assert.equal(request.name, providerName);
      assert.deepEqual(sandbox.spec.providers, [providerName]);
      assert.equal(expectedVersion, provider.resourceVersion);
      updates.push(request);
      provider = { ...provider, config: request.config ?? {}, resourceVersion: "2" };
      const mutationId = randomUUID();
      const receiptId = randomUUID();
      const desired = {
        sandboxId,
        sandbox: sandboxName,
        attachmentEpoch,
        providerId: provider.id!,
        providerResourceVersion: provider.resourceVersion,
        providerEnvRevision: "2",
        configRevision: "2",
        policyHash,
      };
      const time = new Date().toISOString();
      status = {
        state: "PROVIDER_READINESS_STATE_READY",
        completedOperationId: receiptId,
        receipt: {
          receiptId,
          kind: "PROVIDER_MUTATION_KIND_UPDATE",
          workspace,
          provider: provider.name,
          desired,
        },
        observed: {
          sessionId: randomUUID(),
          sequence: "1",
          attachmentEpoch,
          providerEnvRevision: "2",
          configRevision: "2",
          policyHash,
          credentialsInstalled: true,
          policyActive: true,
          launchEnvironmentInstalled: true,
          processInstanceId: randomUUID(),
          reason: "",
        },
        networkInstanceId,
        observedTime: time,
        evaluatedTime: time,
      };
      return {
        ...provider,
        mutationId,
        targetReceipts: [
          {
            receipt_id: receiptId,
            mutation_id: mutationId,
            kind: "PROVIDER_MUTATION_KIND_UPDATE",
            workspace,
            provider: provider.name,
            desired: {
              sandbox_id: sandboxId,
              sandbox: sandboxName,
              provider_id: provider.id,
              provider_resource_version: provider.resourceVersion,
            },
          },
        ],
      };
    },
    async getSandbox(request) {
      assert.equal(request.workspace, workspace);
      assert.equal(request.name, sandboxName);
      return sandbox;
    },
    async getSandboxProviderStatus(
      requestWorkspace,
      requestedSandbox,
      requestedProvider,
      _signal,
      receiptId,
    ) {
      assert.equal(requestWorkspace, workspace);
      assert.equal(requestedSandbox, sandboxName);
      assert.equal(requestedProvider, providerName);
      assert.ok(receiptId && status);
      receiptReads.push(receiptId);
      assert.equal(receiptId, status.receipt?.receiptId);
      return status;
    },
  } satisfies Partial<OpenShellGatewayClient>;
  return { client, updates, receiptReads, sandbox, provider: () => provider, status: () => status };
}

async function stagedCredentialScenario(
  fixture: RevisionFixture,
  context: TestContext,
  extendCompute: (compute: ComputeDriver) => ComputeDriver,
) {
  const grant = {
    id: "model-egress",
    binary: "/app/bin/model-client",
    host: "api.openai.com",
    ports: [{ from: 443, to: 443 }],
  };
  const installation = buildSandboxInstallation();
  Reflect.deleteProperty(installation.drivers, "credential_gateway");
  Reflect.deleteProperty(installation.backend[0]!.drivers, "credential_gateway");
  Object.assign(installation.drivers, { token_service: { id: "occ", configuration: {} } });
  installation.drivers.compute.id = fixture.compute.id;
  const baseline = installation.drivers.sandbox.configuration.policy.networkPolicies[0]!;
  baseline.name = "baseline";
  baseline.endpoints[0]!.host = "baseline.example.test";
  const gatewayTransport: Partial<OpenShellGatewayClient> = {};
  const runtime = await loadInstallationFile(context, installation, {
    createOpenShellBackend: (definition) =>
      createOpenShellBackend(definition, {
        gatewayClient: completeOpenShellGatewayClient(gatewayTransport),
      }),
  });
  assert.ok(runtime?.credentialDeliveryRegistration && runtime.sandboxDriver);
  const registration = runtime.credentialDeliveryRegistration;
  const sandbox = registration.require("sandbox");
  // Control Compute and deployment configuration only. The API and Worker share the exact
  // selected native Proxy; its Source notification and Gateway receipt handling remain real.
  const deliveries: {
    namespace: Readonly<Namespace>;
    targetRef: Parameters<CredentialProxyDriver["configureDeployment"]>[1]["targetRef"];
    configurationId: string;
    binding: DeploymentCredentialBinding;
    credential: ResolvedCredential;
  }[] = [];
  const proxy = registration.require("credential_proxy_delivery");
  proxy.configureDeployment = async (deploymentContext, input) => {
    const supplied = input.bindings[0];
    assert.ok(supplied && input.bindings.length === 1);
    deliveries.push({
      namespace: deploymentContext.namespace,
      targetRef: input.targetRef,
      configurationId: input.configurationId,
      binding: supplied.binding,
      credential: await supplied.resolveCredential(),
    });
    return {
      credentialProjections: [
        {
          bindingRef: supplied.binding.bindingRef,
          environment: supplied.binding.projection.environment,
          placeholder: { kind: "runtime" },
        },
      ],
    };
  };
  const placedName = `placed-${randomUUID().slice(0, 8)}`;
  const compute = extendCompute({
    ...fixture.compute,
    resolveHarnessConfiguration: () => ({
      modelProvider: { protocol: "openai-responses", baseUrl: "https://api.openai.com/v1" },
    }),
    validateExecutionAdmission() {},
    async resolveSandboxNamespace(namespace) {
      return { ...namespace, name: placedName };
    },
    async prepareRevision(revision) {
      return {
        ...(await fixture.compute.prepareRevision(revision)),
        ready: false,
        pendingReason: "CREDENTIAL_ACTIVATION_PENDING",
        preparedForCredentialActivation: true,
      };
    },
  });
  const controller = new OpenClawController(fixture.installation, {
    state: fixture.state,
    ...installationControllerOptions(runtime.installation),
    nativeWorkerSupport: "custom-image",
    sandboxNetworkPolicyCeiling: [grant],
    namespaceLifecycleBindings: runtime.namespaceLifecycleBindings,
    backends: runtime.installation.backend,
    recordOperations: true,
  });
  for (const capability of ["iam", "configuration"] as const) {
    const selected = fixture.controller.selectedDriver(capability);
    controller.registerDriver(selected);
    controller.selectDriver(capability, selected.id);
  }
  controller.registerDriver(compute);
  controller.selectDriver("compute", compute.id);
  installSelectedSandboxDrivers(controller, runtime);
  const { driver: secretDriver } = useInstallationSecretDriver(controller);
  await installTokenServiceDriver(controller, { ...runtime, secretDriver }, fixture.state);
  const namespaceId = fixture.namespace.id;
  const actorId = fixture.actor.id;
  const enrolledCredential = randomUUID();
  const source = await controller.createManagedCredentialSource(
    actorId,
    namespaceId,
    {
      name: `Activation source ${randomUUID()}`,
      lifecycleConfig: { type: "static", settings: {} },
      secret: { opaque: enrolledCredential },
      providerPreset: "openai",
    },
    (ref, phase) => ({
      ...auditEvent(
        fixture.installation.id,
        namespaceId,
        actorId,
        phase ? "openclaw.credential_sources.create.started" : "openclaw.credential_sources.create",
        ref,
      ),
      ...(phase ? { details: { phase } } : {}),
    }),
  );
  const configuration = await controller.createConfiguration(actorId, {
    namespaceId,
    kind: "agent",
    values: createHarnessConfiguration("openclaw", "gpt-4.1"),
  });
  const owner = await controller.createAgent(
    actorId,
    {
      namespaceId,
      name: `Activation race ${randomUUID()}`,
      configurationId: configuration.id,
      executionMode: "dedicated",
      harnessAuth: { method: "credential_source", sourceId: source.id },
      credentialSources: [{ sourceId: source.id }],
    },
    resolveApprovedHarness,
  );
  await controller.TEMPORARY_API_WILL_BREAK_IN_FUTURE_setAgentSandboxPolicyEditing(
    actorId,
    namespaceId,
    owner.id,
    "networking",
    true,
  );
  await controller.updateAgentSandboxPolicy(actorId, namespaceId, owner.id, "networking", 1, [
    grant,
  ]);

  const workerOptions = {
    transformDrivers: (drivers) => ({
      ...drivers,
      installation: {
        ...runtime.installation,
        drivers: {
          ...runtime.installation.drivers,
          secret: { ...runtime.installation.drivers.secret, id: secretDriver.id },
        },
      },
      secretDriver,
      namespaceLifecycleBindings: runtime.namespaceLifecycleBindings,
      credentialDeliveryRegistration: registration,
      sandboxDriver: sandbox,
    }),
  } satisfies NonNullable<Parameters<RevisionFixture["start"]>[1]>;
  await fixture.start(compute, workerOptions);
  return {
    controller,
    owner,
    source,
    namespaceId,
    actorId,
    enrolledCredential,
    deliveries,
    placedName,
    gatewayTransport,
    currentAgent: () => fixture.currentAgent(owner),
  };
}

cases.revisionTest(
  "a terminal Credential Proxy failure permanently fails Work with its exact code",
  async (fixture, context) => {
    const code = "NATIVE_CREDENTIAL_DEPLOYMENT_REFUSED";
    let preparations = 0;
    let activations = 0;
    const { controller, owner, namespaceId, actorId, currentAgent } =
      await stagedCredentialScenario(fixture, context, (compute) => ({
        ...compute,
        async prepareRevision() {
          preparations += 1;
          throw new CredentialDeploymentFailedError(code);
        },
        async activateRevision() {
          activations += 1;
        },
      }));
    const revision = await controller.deployAgent(
      actorId,
      { namespaceId, agentId: owner.id },
      resolveApprovedHarness,
    );
    const work = { id: revision.id, idempotencyKey: `agent_revision:${revision.id}:reconcile` };
    await fixture.work(work, "failed_permanent");
    assert.equal((await fixture.workResult(work)).rows[0]?.reason_code, code);
    assert.equal(preparations, 1);
    assert.equal(activations, 0);
    assert.equal((await currentAgent())?.activeRevisionId, undefined);
  },
);

cases.revisionTest(
  "standalone activation commits the prepared revision and delivers an active Source PATCH",
  async (fixture, context) => {
    let preparations = 0;
    let activations = 0;
    let configurationError: unknown;
    const sandboxId = randomUUID();
    const {
      controller,
      owner,
      source,
      namespaceId,
      actorId,
      enrolledCredential,
      deliveries,
      placedName,
      currentAgent,
      gatewayTransport,
    } = await stagedCredentialScenario(fixture, context, (compute) => ({
      ...compute,
      async prepareRevision(revision, revisionContext) {
        preparations += 1;
        assert.equal(activations, 0, "activation succeeds without another preparation");
        assert.deepEqual(revisionContext?.harnessAuth, revision.harnessAuth);
        assert.deepEqual(revisionContext?.secretEnvironment, []);
        assert.ok(revisionContext?.configureCredentialDeployment);
        const configured = await revisionContext
          .configureCredentialDeployment(
            {
              targetRef: { namespaceId, agentId: owner.id, revisionId: revision.id, sandboxId },
              configurationId: revision.configurationId,
            },
            AbortSignal.timeout(5_000),
          )
          .catch((error: unknown) => {
            configurationError = error;
            throw error;
          });
        assert.deepEqual(configured, {
          credentialProjections: [
            {
              bindingRef: "model",
              environment: "OPENAI_API_KEY",
              placeholder: { kind: "runtime" },
            },
          ],
        });
        return compute.prepareRevision(revision, revisionContext);
      },
      async activateRevision(revision) {
        assert.equal((await currentAgent())?.activeRevisionId, revision.id);
        activations += 1;
      },
    }));
    const tokenService = controller.selectedDriver("token_service");
    const sourceInstance = {
      sourceRef: source.ref,
      tokenServiceInstanceId: controller.currentTokenServiceInstanceId(),
    };
    const canonical = await tokenService.resolveCredential(
      sourceInstance,
      AbortSignal.timeout(5_000),
    );
    assert.equal(canonical.credential, enrolledCredential);
    assert.ok(canonical.version);
    const revision = await controller.deployAgent(
      actorId,
      { namespaceId, agentId: owner.id },
      resolveApprovedHarness,
    );
    assert.equal(revision.executionAdmission.version, 8);
    const work = { id: revision.id, idempotencyKey: `agent_revision:${revision.id}:reconcile` };
    await fixture.work(work, "succeeded").catch((error: unknown) => {
      throw configurationError ?? error;
    });
    assert.equal((await currentAgent())?.activeRevisionId, revision.id);
    assert.equal(preparations, 1);
    assert.equal(activations, 1);
    assert.deepEqual(revision.credentialDeployment?.bindings, [
      {
        bindingRef: "model",
        sourceRef: source.ref,
        consumer: { kind: "model", providerId: "openai" },
        projection: { environment: "OPENAI_API_KEY", presentation: "bearer" },
      },
    ]);
    assert.deepEqual(deliveries, [
      {
        namespace: { ...fixture.namespace, name: placedName },
        targetRef: { namespaceId, agentId: owner.id, revisionId: revision.id, sandboxId },
        configurationId: revision.configurationId,
        binding: revision.credentialDeployment!.bindings[0],
        credential: { credential: enrolledCredential, version: canonical.version },
      },
    ]);
    // Worker shutdown closes its database pool. Source PATCH must retain the API-bound placement
    // resolver instead of depending on a resolver installed by the Worker.
    await fixture.stop();

    // The Worker has committed a real active v8 binding. Control only the Gateway transport:
    // the selected native Proxy must push the committed Source version and acknowledge the
    // attached target's UPDATE receipt before the authenticated Source PATCH succeeds.
    const nativeProxy = controller.selectedDriver("credential_proxy_delivery");
    assert.ok(nativeProxy instanceof OpenShellCredentialProxyDriver);
    const gateway = recordingActiveGateway(namespaceId, placedName, sandboxId, source.id);
    Object.assign(gatewayTransport, gateway.client);
    const preparedProvider = await prepareOccTokenServiceProviderCopy({
      client: gateway.client,
      workspace: placedName,
      namespaceId,
      binding: revision.credentialDeployment!.bindings[0]!,
      resolveCredential: () => tokenService.resolveCredential(sourceInstance, context.signal),
      signal: context.signal,
    });
    // The Worker-side deployment Proxy is controlled in this fixture. Simulate its existing
    // Gateway attachment explicitly; creating a Provider alone does not attach it to a Sandbox.
    gateway.sandbox.spec.providers.push(preparedProvider.name);

    const origin = "https://console.oce.localhost";
    const auth = await createPostgresControllerAuth({
      mode: "development",
      installationId: fixture.installation.id,
      baseURL: origin,
      agentDomain: "agents.oce.localhost",
      secret: "active-source-update-integration-session-secret",
      pool: fixture.observerPool,
    });
    const credentials = {
      email: `source-updater-${randomUUID()}@example.test`,
      password: randomUUID(),
    };
    const iam = await fixture.state.loadNativeIAMState(fixture.installation.id);
    const roleId = iam.bindings.find((binding) => binding.subjectId === fixture.actor.id)?.roleId;
    assert.ok(roleId);
    const account = await auth.createAccount({ ...credentials, name: "Source updater" });
    const seed = auth.principalSeed(account, { roleId });
    await fixture.state.appendNativeIAMPrincipal(seed);
    // Additional password accounts receive an Installation-only grant. Give this account
    // exact update authority on the already active Source through the regular IAM caller.
    const sourceUpdateRole = await controller.createIAMRole(actorId, {
      namespaceId,
      permissions: [{ action: "update", resourceKind: "credential_source" }],
    });
    await controller.createIAMAccessBinding(actorId, {
      namespaceId,
      subjectKind: "identity",
      subjectId: seed.principal.id,
      roleId: sourceUpdateRole.id,
      resourceKind: "credential_source",
      resourceId: source.id,
    });
    const app = createFastifyApp({
      controller,
      iamDriver: controller.selectedDriver("iam"),
      resolveHarness: resolveApprovedHarness,
      auditSink: fixture.state.auditSink,
      auth,
      development: { enabled: false },
    });
    const replacement = randomUUID();
    try {
      const session = await signInToControllerApp(app, credentials, { origin });
      const updated = await app.inject({
        method: "PATCH",
        url: `/namespaces/${namespaceId}/credential-sources/${source.id}`,
        headers: {
          host: new URL(origin).host,
          ...authenticatedHeaders(session),
          "content-type": "application/json",
        },
        payload: { secret: { opaque: replacement } },
      });
      assert.equal(updated.statusCode, 200, updated.body);
      assert.equal(updated.body.includes(replacement), false);
    } finally {
      await app.close();
    }
    const current = await tokenService.resolveCredential(sourceInstance, context.signal);
    assert.equal(current.credential, replacement);
    assert.notEqual(current.version, canonical.version);
    assert.equal(gateway.updates.length, 1);
    const { workspace, name, credentials: delivered, config } = gateway.updates[0]!;
    assert.deepEqual(
      { workspace, name, credentials: delivered, config },
      {
        workspace: placedName,
        name: preparedProvider.name,
        credentials: { OPENAI_API_KEY: replacement },
        config: { oce_source_version: current.version },
      },
    );
    assert.equal(gateway.provider()?.config.oce_source_version, current.version);
    assert.deepEqual(gateway.receiptReads, [gateway.status()?.receipt?.receiptId]);
    assert.equal((await currentAgent())?.activeRevisionId, revision.id);
    assert.deepEqual(
      (
        await fixture.observerPool.query(
          "SELECT state,config FROM occ.credential_sources WHERE id=$1",
          [source.id],
        )
      ).rows,
      [{ state: "ready", config: { provider_preset: "openai" } }],
    );

    // Live withdrawal cannot use the legacy withdrawal path for staged TokenService delivery.
    await assert.rejects(
      controller.withdrawAgentCredentialSource(actorId, {
        namespaceId,
        agentId: owner.id,
        credentialSourceId: source.id,
      }),
      (error: unknown) =>
        error instanceof ResourceStateConflictError &&
        error.message ===
          "Withdrawal of a staged TokenService credential source is not supported. Complete Agent Stop to retire the revision.",
    );
    const withdrawal = await fixture.observerPool.query(
      `SELECT credential_source_id FROM occ.credential_withdrawals
       WHERE namespace_id=$1 AND revision_id=$2 AND credential_source_id=$3`,
      [namespaceId, revision.id, source.id],
    );
    const withdrawalWork = await fixture.observerPool.query(
      `SELECT idempotency_key FROM occ.controller_work
       WHERE namespace_id=$1 AND revision_id=$2 AND agent_target='credentials_withdrawn'`,
      [namespaceId, revision.id],
    );
    assert.deepEqual(withdrawal.rows, []);
    assert.deepEqual(withdrawalWork.rows, []);

    // An active staged revision cannot be replaced, including by a non-staged draft.
    await controller.updateAgent(
      actorId,
      {
        namespaceId,
        agentId: owner.id,
        configurationId: owner.configurationId,
        harnessAuth: { method: "runtime" },
        credentialSources: [],
      },
      resolveApprovedHarness,
    );
    await assert.rejects(
      controller.deployAgent(actorId, { namespaceId, agentId: owner.id }, resolveApprovedHarness),
      (error: unknown) =>
        error instanceof ResourceStateConflictError &&
        /active staged managed-credential revision/.test(error.message),
    );
    assert.equal((await currentAgent())?.activeRevisionId, revision.id);
    assert.equal(preparations, 1);
    assert.equal(activations, 1);
    const successorRevisions = await fixture.observerPool.query(
      `SELECT id FROM occ.agent_revisions WHERE namespace_id=$1 AND agent_id=$2 AND id<>$3`,
      [namespaceId, owner.id, revision.id],
    );
    const successorWork = await fixture.observerPool.query(
      `SELECT idempotency_key FROM occ.controller_work
       WHERE namespace_id=$1 AND agent_id=$2 AND revision_id<>$3`,
      [namespaceId, owner.id, revision.id],
    );
    assert.deepEqual(successorRevisions.rows, []);
    assert.deepEqual(successorWork.rows, []);

    // A new Agent can save repository restrictions before its first deployment, but
    // standalone credential admission cannot claim it can enforce those restrictions.
    const scopedConfiguration = await controller.createConfiguration(actorId, {
      namespaceId,
      kind: "agent",
      values: createHarnessConfiguration("openclaw", "gpt-4.1"),
    });
    const scopedOwner = await controller.createAgent(
      actorId,
      {
        namespaceId,
        name: `Scoped activation ${randomUUID()}`,
        configurationId: scopedConfiguration.id,
        executionMode: "dedicated",
        harnessAuth: { method: "credential_source", sourceId: source.id },
        credentialSources: [{ sourceId: source.id }],
      },
      resolveApprovedHarness,
    );
    await fixture.state.transact(async (unit) => {
      await unit.namespaces.lockNamespace(namespaceId);
      await unit.agents.lockAgent(namespaceId, scopedOwner.id);
      const current = await unit.sandboxPolicies.find(namespaceId, scopedOwner.id);
      assert.ok(current);
      assert.ok(
        await unit.sandboxPolicies.save(
          { ...current, version: current.version + 1, repositoryNetworkPolicy: [] },
          current.version,
        ),
      );
    });
    await assert.rejects(
      controller.deployAgent(
        actorId,
        { namespaceId, agentId: scopedOwner.id },
        resolveApprovedHarness,
      ),
      (error: unknown) =>
        error instanceof ResourceStateConflictError &&
        /saved repository network policy/.test(error.message),
    );
    const scopedRevisions = await fixture.observerPool.query(
      "SELECT id FROM occ.agent_revisions WHERE namespace_id=$1 AND agent_id=$2",
      [namespaceId, scopedOwner.id],
    );
    const scopedWork = await fixture.observerPool.query(
      "SELECT idempotency_key FROM occ.controller_work WHERE namespace_id=$1 AND agent_id=$2",
      [namespaceId, scopedOwner.id],
    );
    assert.deepEqual(scopedRevisions.rows, []);
    assert.deepEqual(scopedWork.rows, []);
  },
);

cases.revisionTest(
  "standalone activation refuses a source grant removed during preparation",
  async (fixture, context) => {
    let activations = 0;
    const { controller, owner, source, namespaceId, actorId, currentAgent } =
      await stagedCredentialScenario(fixture, context, (compute) => ({
        ...compute,
        async prepareRevision(revision) {
          const observation = await compute.prepareRevision(revision);
          // Preparation was authorized. Remove the exact Agent grant before it returns so
          // only the ordinary release authorization can prevent activation.
          await removeSourceGrant(fixture, owner, source.id);
          return observation;
        },
        async activateRevision() {
          activations += 1;
        },
      }));
    const revision = await controller.deployAgent(
      actorId,
      { namespaceId, agentId: owner.id },
      resolveApprovedHarness,
    );
    const work = { id: revision.id, idempotencyKey: `agent_revision:${revision.id}:reconcile` };
    await fixture.work(work, "failed_permanent");
    assert.equal((await currentAgent())?.activeRevisionId, revision.id);
    assert.equal(activations, 0);
    assert.equal((await fixture.workResult(work)).rows[0]?.reason_code, "AUTHORIZATION_DENIED");
    const audit = await fixture.observerPool.query(
      `SELECT details->'__occAuditMetadata'->'authorization' AS authorization
       FROM occ.audit_events WHERE namespace_id=$1 AND resource_id=$2 AND kind='authorization_denial'`,
      [namespaceId, owner.id],
    );
    assert.deepEqual(audit.rows, [
      {
        authorization: {
          principalId: owner.servicePrincipalId,
          action: "operate",
          resource: { kind: "credential_source", namespaceId, id: source.id },
        },
      },
    ]);
  },
);

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, type TestContext } from "node:test";
import type { ComputeDriver, Namespace } from "../../packages/contracts/src/index.ts";
import { OpenClawController, ResourceStateConflictError } from "../../packages/occ/src/index.ts";
import { createOpenShellBackend } from "../../apps/controller/src/backends/openshell.ts";
import { installationControllerOptions } from "../../apps/controller/src/composition/installation-config.ts";
import { installSelectedSandboxDrivers } from "../../apps/controller/src/composition/sandbox-drivers.ts";
import { installTokenServiceDriver } from "../../apps/controller/src/composition/token-service.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import type { RevisionFixture } from "../helpers/postgres-worker-refused-candidate.ts";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import { useInstallationSecretDriver } from "../helpers/kubernetes-secret-core.mjs";
import { auditEvent } from "./postgres-namespace-iam-fixture.ts";
import { buildSandboxInstallation } from "./sandbox-driver-installation-fixture.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";
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

function stagedGatewayClient(namespace: Namespace) {
  const gateway = workspaceGatewayClient([
    {
      id: randomUUID(),
      name: namespace.name,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace-id": namespace.id,
      },
      phase: "WORKSPACE_PHASE_ACTIVE",
    },
  ]);
  const importProfile = gateway.importProviderProfile;
  gateway.importProviderProfile = async (workspace, profile, signal) => {
    await importProfile(workspace, profile, signal);
    const stored = gateway.profiles.get(profile.id);
    assert.ok(stored);
    gateway.profiles.set(profile.id, {
      ...stored,
      definition: {
        inference_capable: profile.inferenceCapable,
        credentials: profile.credentials.map((credential) => ({
          name: credential.name,
          env_vars: credential.envVars,
          required: credential.required,
          auth_style: credential.authStyle,
          header_name: credential.headerName,
          stable_placeholder: credential.stablePlaceholder,
        })),
        endpoints: [],
        binaries: [],
      },
    });
  };
  const createProvider = gateway.createProvider;
  gateway.createProvider = async (request, signal) => {
    const created = await createProvider(request, signal);
    const provider = {
      ...created,
      id: randomUUID(),
      workspace: request.workspace,
      profileWorkspace: request.workspace,
    };
    gateway.providers.set(request.name, provider);
    return provider;
  };
  gateway.attachSandboxProviderWithReceipt = async (
    workspace,
    name,
    providerName,
    _signal,
    conditional,
  ) => {
    const sandbox = gateway.sandboxes.get(name);
    const provider = gateway.providers.get(providerName);
    assert.ok(sandbox && provider?.id);
    assert.equal(sandbox.workspace, workspace);
    assert.equal(sandbox.resourceVersion, conditional.expectedResourceVersion);
    assert.ok(conditional.requestId);
    const attached = {
      ...sandbox,
      resourceVersion: String(Number(sandbox.resourceVersion) + 1),
      spec: { ...sandbox.spec, providers: [providerName] },
    };
    gateway.sandboxes.set(name, attached);
    return {
      sandbox: attached,
      attached: true,
      receiptId: randomUUID(),
      providerId: provider.id,
      providerResourceVersion: provider.resourceVersion,
    };
  };
  return gateway;
}

async function stagedCredentialScenario(
  fixture: RevisionFixture,
  context: TestContext,
  extendCompute: (compute: ComputeDriver) => ComputeDriver,
) {
  // OpenShell identifies a workspace by a DNS label of at most 19 characters. The shared
  // Worker fixture's generic Namespace name is intentionally not an OpenShell workspace name.
  const namespace: Namespace = {
    ...fixture.namespace,
    id: `ns_${randomUUID()}`,
    name: `staged-${randomUUID().slice(0, 8)}`,
  };
  await fixture.state.transact((state) => state.namespaces.createNamespace(namespace));
  const gateway = stagedGatewayClient(namespace);
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
  const runtime = await loadInstallationFile(context, installation, {
    createOpenShellBackend: (definition) =>
      createOpenShellBackend(definition, { gatewayClient: gateway }),
  });
  assert.ok(runtime?.credentialDeliveryRegistration && runtime.sandboxDriver);
  const registration = runtime.credentialDeliveryRegistration;
  const sandbox = registration.require("sandbox");
  // Compute and Gateway transport are controlled; the selected Proxy, TokenService, Worker,
  // PostgreSQL, and Native IAM paths remain real. This does not prove native process readiness.
  const compute = extendCompute({
    ...fixture.compute,
    resolveHarnessConfiguration: () => ({
      modelProvider: { protocol: "openai-responses", baseUrl: "https://api.openai.com/v1" },
    }),
    validateExecutionAdmission() {},
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
  const namespaceId = namespace.id;
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
  const currentAgent = () =>
    fixture.state.read((view) => view.agents.findAgent(namespaceId, owner.id));
  return {
    controller,
    owner,
    source,
    namespace,
    namespaceId,
    actorId,
    gateway,
    sandbox,
    enrolledCredential,
    currentAgent,
  };
}

cases.revisionTest(
  "standalone activation commits the prepared revision before first startup",
  async (fixture, context) => {
    let preparations = 0;
    let activations = 0;
    const sandboxId = randomUUID();
    const {
      controller,
      owner,
      source,
      namespace,
      namespaceId,
      actorId,
      gateway,
      sandbox,
      enrolledCredential,
      currentAgent,
    } = await stagedCredentialScenario(fixture, context, (compute) => ({
      ...compute,
      async prepareRevision(revision, revisionContext) {
        preparations += 1;
        assert.equal(activations, 0, "activation succeeds without another preparation");
        assert.deepEqual(revisionContext?.harnessAuth, revision.harnessAuth);
        assert.deepEqual(revisionContext?.secretEnvironment, []);
        const resource = sandbox.harnessResource!({ namespace, revision });
        const targetRef = {
          namespaceId,
          agentId: owner.id,
          revisionId: revision.id,
          sandboxId,
        };
        gateway.sandboxes.set(resource.resourceName, {
          id: sandboxId,
          name: resource.resourceName,
          workspace: namespace.name,
          resourceVersion: "1",
          labels: {
            "app.kubernetes.io/managed-by": "openclaw-enterprise",
            "openclaw.dev/namespace": namespaceId,
            "openclaw.dev/agent": owner.id,
            "openclaw.dev/revision": revision.id,
          },
          annotations: {
            "openclaw.dev/namespace-id": namespaceId,
            "openclaw.dev/agent-id": owner.id,
            "openclaw.dev/revision-id": revision.id,
            "openclaw.dev/configuration-id": revision.configurationId,
          },
          spec: { providers: [] },
          serviceUrls: {},
        });
        assert.ok(revisionContext?.configureCredentialDeployment);
        const configured = await revisionContext.configureCredentialDeployment(
          { targetRef, configurationId: revision.configurationId },
          AbortSignal.timeout(5_000),
        );
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
    await fixture.work(work, "succeeded");
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
    const creates = gateway.calls.filter((call) => call[0] === "createProvider");
    assert.equal(creates.length, 1);
    const provider = creates[0]![1];
    assert.equal(provider.workspace, namespace.name);
    assert.deepEqual(provider.credentials, { OPENAI_API_KEY: enrolledCredential });
    assert.deepEqual(provider.config, { oce_source_version: canonical.version });
    assert.deepEqual(
      gateway.sandboxes.get(sandbox.harnessResource!({ namespace, revision }).resourceName)?.spec
        ?.providers,
      [provider.name],
    );

    // A Source used by the active staged revision cannot rotate until delivery notification
    // and retry can settle its existing projections. Refusal must leave custody unchanged.
    const updateAudit = () =>
      auditEvent(
        fixture.installation.id,
        namespaceId,
        actorId,
        "openclaw.credential_sources.update",
        source.ref,
      );
    await assert.rejects(
      controller.updateManagedCredentialSource(
        actorId,
        { namespaceId, credentialSourceId: source.id },
        { secret: { opaque: randomUUID() } },
        updateAudit,
        (reasonCode) => ({ ...updateAudit(), outcome: "failure", reasonCode }),
      ),
      (error: unknown) =>
        error instanceof ResourceStateConflictError && /active staged revision/.test(error.message),
    );
    assert.deepEqual(
      await tokenService.resolveCredential(sourceInstance, AbortSignal.timeout(5_000)),
      canonical,
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

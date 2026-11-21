import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, type TestContext } from "node:test";
import type { ComputeDriver } from "../../packages/contracts/src/index.ts";
import {
  ActivationPendingError,
  OpenClawController,
  PostgresPlatformState,
  ResourceStateConflictError,
} from "../../packages/occ/src/index.ts";
import { installationControllerOptions } from "../../apps/controller/src/composition/installation-config.ts";
import { installSelectedSandboxDrivers } from "../../apps/controller/src/composition/sandbox-drivers.ts";
import { installTokenServiceDriver } from "../../apps/controller/src/composition/token-service.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import type { RevisionFixture, WorkerEvent } from "../helpers/postgres-worker-refused-candidate.ts";
import { waitFor } from "../helpers/wait-for.ts";
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
  const runtime = await loadInstallationFile(context, installation);
  assert.ok(runtime?.credentialDeliveryRegistration && runtime.sandboxDriver);
  const registration = runtime.credentialDeliveryRegistration;
  const sandbox = registration.require("sandbox");
  // The recipient and Compute are controlled dependencies. This tests Worker authorization;
  // it does not qualify a native process, proxy transfer, or runtime enforcement.
  Object.assign(sandbox, {
    credentialDeployment() {
      throw new Error("the controlled Compute must not configure a recipient");
    },
  });
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
    credentialDeploymentCapabilities: () => ({
      binary: grant.binary,
      sandbox: { wildcards: false, portRanges: false, supportsNetworkPolicy: () => true },
      proxy: {
        distinguishesExecutable: true,
        distinguishesPort: true,
        rejectsStaleAndMisplacedPlaceholders: true,
        supportsBindingRequest: () => true,
      },
    }),
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
  await installTokenServiceDriver(controller, {
    installation: runtime.installation,
    secretDriver,
  });
  const namespaceId = fixture.namespace.id;
  const actorId = fixture.actor.id;
  const source = await controller.createManagedCredentialSource(
    actorId,
    namespaceId,
    {
      name: `Activation source ${randomUUID()}`,
      lifecycleConfig: { type: "static", settings: {} },
      secret: { opaque: randomUUID() },
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
      resolveCredentialDeploymentContext: async () => {
        throw new Error("the controlled Compute must not resolve a recipient");
      },
    }),
  } satisfies NonNullable<Parameters<RevisionFixture["start"]>[1]>;
  const startWorker = (emit?: (event: WorkerEvent) => void) =>
    fixture.start(compute, { ...workerOptions, ...(emit === undefined ? {} : { emit }) });
  await startWorker();
  return { controller, owner, source, namespaceId, actorId, startWorker };
}

function workerState(fixture: RevisionFixture): PostgresPlatformState {
  const worker: unknown = [...fixture.database.workers].at(-1);
  assert.ok(
    typeof worker === "object" &&
      worker !== null &&
      "state" in worker &&
      worker.state instanceof PostgresPlatformState,
  );
  return worker.state;
}

cases.revisionTest(
  "standalone activation rechecks the Agent's exact source grant after committing the active revision",
  async (fixture, context) => {
    let activations = 0;
    let serving = false;
    const stopped: string[] = [];
    const retired: string[] = [];
    const { controller, owner, source, namespaceId, actorId } = await stagedCredentialScenario(
      fixture,
      context,
      (compute) => ({
        ...compute,
        async prepareRevision(revision) {
          return serving
            ? fixture.compute.prepareRevision(revision)
            : compute.prepareRevision(revision);
        },
        async activateRevision() {
          activations += 1;
          serving = true;
        },
        async stopRevision(revision) {
          stopped.push(revision.id);
          serving = false;
          await fixture.compute.stopRevision(revision);
        },
        async retireRevision(revision) {
          retired.push(revision.id);
          await fixture.compute.retireRevision(revision);
        },
      }),
    );
    const state = workerState(fixture);
    const transactWithQueue = state.transactWithQueue.bind(state);
    let revoked = false;
    let sourceRoleId: string | undefined;
    state.transactWithQueue = async (work, options) => {
      const result = await transactWithQueue(work, options);
      // Revoke only after PostgreSQL committed the candidate's active pointer, before the
      // same Worker pass resumes activation. This is the actual race window.
      if (!revoked && (await fixture.currentAgent(owner))?.activeRevisionId !== undefined) {
        revoked = true;
        const grant = await fixture.observerPool.query<{ role_id: string }>(
          `SELECT role_id FROM occ.iam_access_bindings WHERE identity_subject_id=$1
           AND resource_kind='credential_source' AND resource_id=$2`,
          [owner.servicePrincipalId, source.id],
        );
        sourceRoleId = grant.rows[0]?.role_id;
        assert.ok(sourceRoleId);
        await removeSourceGrant(fixture, owner, source.id);
      }
      return result;
    };
    const revision = await controller.deployAgent(
      actorId,
      { namespaceId, agentId: owner.id },
      resolveApprovedHarness,
    );
    assert.equal(revision.executionAdmission.version, 8);
    const work = { id: revision.id, idempotencyKey: `agent_revision:${revision.id}:reconcile` };
    await fixture.work(work, "failed_permanent");
    assert.equal(revoked, true, "the exact binding was deleted after the active pointer commit");
    assert.equal(activations, 0);
    assert.equal((await fixture.workResult(work)).rows[0]?.reason_code, "AUTHORIZATION_DENIED");
    const audit = await fixture.observerPool.query(
      `SELECT kind, actor_id, outcome,
        details->'__occAuditMetadata'->'authorization' AS authorization,
        details->'__occAuditMetadata'->>'reasonCode' AS reason_code
       FROM occ.audit_events WHERE namespace_id=$1 AND resource_id=$2 AND kind='authorization_denial'`,
      [namespaceId, owner.id],
    );
    assert.deepEqual(audit.rows, [
      {
        kind: "authorization_denial",
        actor_id: actorId,
        outcome: "denied",
        authorization: {
          principalId: owner.servicePrincipalId,
          action: "operate",
          resource: { kind: "credential_source", namespaceId, id: source.id },
        },
        reason_code: "AUTHORIZATION_DENIED",
      },
    ]);

    // Restoring authority does not turn a selected failed staged revision into a supported
    // replacement. Stop must finish through the ordinary Agent lifecycle before a fresh launch.
    assert.ok(sourceRoleId);
    await controller.createIAMAccessBinding(actorId, {
      namespaceId,
      subjectKind: "identity",
      subjectId: owner.servicePrincipalId,
      roleId: sourceRoleId,
      resourceKind: "credential_source",
      resourceId: source.id,
    });
    await assert.rejects(
      controller.deployAgent(actorId, { namespaceId, agentId: owner.id }, resolveApprovedHarness),
      (error: unknown) =>
        error instanceof ResourceStateConflictError &&
        /active staged managed-credential revision.*Complete Stop before deploying again/.test(
          error.message,
        ),
    );
    const stop = await fixture.requestStop(owner);
    await fixture.work(stop, "succeeded");
    assert.deepEqual(stopped, [revision.id]);
    assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, undefined);
    const recovered = await controller.deployAgent(
      actorId,
      { namespaceId, agentId: owner.id },
      resolveApprovedHarness,
    );
    assert.equal(recovered.executionAdmission.version, 8);
    await fixture.work(
      { id: recovered.id, idempotencyKey: `agent_revision:${recovered.id}:reconcile` },
      "succeeded",
    );
    assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, recovered.id);
    assert.equal(activations, 1);
    assert.deepEqual(retired, [revision.id]);
  },
);

cases.revisionTest(
  "standalone activation commits a prepared pointer and adopts an uncertain release before completion",
  async (fixture, context) => {
    let released = false;
    let serving = false;
    let releases = 0;
    let activationAttempts = 0;
    const allowServing = Promise.withResolvers<void>();
    const { controller, owner, namespaceId, actorId } = await stagedCredentialScenario(
      fixture,
      context,
      (compute) => ({
        ...compute,
        async prepareRevision(revision) {
          if (!released) {
            assert.equal(
              (await fixture.currentAgent({ id: revision.agentId }))?.activeRevisionId,
              undefined,
            );
            return compute.prepareRevision(revision);
          }
          // A dispatched release with a lost reply is no longer provably held. Compute can
          // report only pending until a retry observes/adopts the same released startup.
          return {
            ...(await fixture.compute.prepareRevision(revision)),
            ready: serving,
            ...(serving ? {} : { pendingReason: "CREDENTIAL_ACTIVATION_PENDING" as const }),
          };
        },
        async activateRevision(revision) {
          assert.equal(
            (await fixture.currentAgent({ id: revision.agentId }))?.activeRevisionId,
            revision.id,
          );
          activationAttempts += 1;
          if (!released) {
            released = true;
            releases += 1;
            throw new ActivationPendingError("CREDENTIAL_ACTIVATION_PENDING", "release reply lost");
          }
          await allowServing.promise;
          serving = true;
        },
      }),
    );
    try {
      const revision = await controller.deployAgent(
        actorId,
        { namespaceId, agentId: owner.id },
        resolveApprovedHarness,
      );
      assert.equal(revision.executionAdmission.version, 8);
      const work = { id: revision.id, idempotencyKey: `agent_revision:${revision.id}:reconcile` };
      await waitFor("the active revision to retry its uncertain release", () =>
        activationAttempts === 2 ? true : undefined,
      );
      assert.equal(releases, 1, "the retry adopts the already released startup");
      assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, revision.id);
      assert.equal((await fixture.work(work, "claimed")).attempt_count, 1);
      const attempts = await fixture.observerPool.query(
        `SELECT details->>'reasonCode' AS reason_code FROM occ.audit_events
         WHERE namespace_id=$1 AND resource_id=$2 AND action='reconcile'
           AND details->>'workId'=$3 AND details->>'reasonCode'=$4`,
        [namespaceId, revision.id, work.idempotencyKey, "CREDENTIAL_ACTIVATION_PENDING"],
      );
      assert.deepEqual(attempts.rows, [{ reason_code: "CREDENTIAL_ACTIVATION_PENDING" }]);
      assert.equal(serving, false, "the deployment remains unfinished until serving is observed");
      allowServing.resolve();
      await fixture.work(work, "succeeded");
      assert.equal(releases, 1);
      assert.equal(activationAttempts, 2);
      assert.equal(
        (await fixture.workResult(work)).rows[0]?.reason_code,
        "REVISION_ALREADY_ACTIVE",
      );
    } finally {
      allowServing.resolve();
    }
  },
);

cases.revisionTest(
  "a pending staged first deployment blocks competing admissions and can finish after a failed attempt",
  async (fixture, context) => {
    let phase = 0;
    let serving = false;
    const firstPrepared = Promise.withResolvers<void>();
    const secondPrepared = Promise.withResolvers<void>();
    const activated: string[] = [];
    const { controller, owner, source, namespaceId, actorId } = await stagedCredentialScenario(
      fixture,
      context,
      (compute) => ({
        ...compute,
        async prepareRevision(revision) {
          if (serving) {
            return fixture.compute.prepareRevision(revision);
          }
          phase += 1;
          await (phase === 1 ? firstPrepared.promise : secondPrepared.promise);
          return compute.prepareRevision(revision);
        },
        async activateRevision(revision) {
          activated.push(revision.id);
          serving = true;
        },
        async stopRevision() {},
      }),
    );
    const deploy = () =>
      controller.deployAgent(actorId, { namespaceId, agentId: owner.id }, resolveApprovedHarness);
    const updateAuth = (staged: boolean) =>
      controller.updateAgent(
        actorId,
        {
          namespaceId,
          agentId: owner.id,
          configurationId: owner.configurationId,
          harnessAuth: staged
            ? { method: "credential_source", sourceId: source.id }
            : { method: "runtime" },
          credentialSources: staged ? [{ sourceId: source.id }] : [],
        },
        resolveApprovedHarness,
      );
    try {
      const failed = await deploy();
      await waitFor("the first staged preparation", () => (phase === 1 ? true : undefined));
      await removeSourceGrant(fixture, owner, source.id);
      firstPrepared.resolve();
      const failedWork = { id: failed.id, idempotencyKey: `agent_revision:${failed.id}:reconcile` };
      await fixture.work(failedWork, "failed_permanent");
      assert.equal(
        (await fixture.workResult(failedWork)).rows[0]?.reason_code,
        "AUTHORIZATION_DENIED",
      );
      assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, undefined);

      // Failed Work is terminal, so a later first launch is valid and admission restores the
      // exact Agent source grant. While it is pending, even a non-staged draft cannot supersede it.
      const first = await deploy();
      await waitFor("the retried staged preparation", () => (phase === 2 ? true : undefined));
      await updateAuth(false);
      await assert.rejects(
        deploy(),
        (error: unknown) =>
          error instanceof ResourceStateConflictError && /still pending/.test(error.message),
      );
      await updateAuth(true);
      secondPrepared.resolve();
      await fixture.work(
        { id: first.id, idempotencyKey: `agent_revision:${first.id}:reconcile` },
        "succeeded",
      );
      assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, first.id);
      assert.deepEqual(activated, [first.id]);

      // Replacing an already active staged revision is unsupported even when the new draft
      // no longer uses a managed credential.
      await updateAuth(false);
      await assert.rejects(
        deploy(),
        (error: unknown) =>
          error instanceof ResourceStateConflictError &&
          /active staged managed-credential revision/.test(error.message),
      );
      assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, first.id);
      assert.equal(
        (
          await fixture.state.read((view) =>
            view.revisions.listRevisionMetadata(namespaceId, owner.id),
          )
        ).length,
        2,
      );
    } finally {
      firstPrepared.resolve();
      secondPrepared.resolve();
    }
  },
);

cases.revisionTest(
  "staged managed credential replacement is refused before touching the active predecessor",
  async (fixture, context) => {
    const prepared: string[] = [];
    const activated: string[] = [];
    const stopped: string[] = [];
    const retired: string[] = [];
    const exposure: string[] = [];
    let preparedRevisionId: string | undefined;
    let pointerCommitPaused = false;
    const allowPointerCommit = Promise.withResolvers<void>();
    const { controller, owner, source, namespaceId, actorId, startWorker } =
      await stagedCredentialScenario(fixture, context, (compute) => ({
        ...compute,
        requiresStoppedPredecessors: () => true,
        async prepareRevision(revision) {
          prepared.push(revision.id);
          preparedRevisionId = revision.id;
          return revision.executionAdmission.version === 8
            ? compute.prepareRevision(revision)
            : fixture.compute.prepareRevision(revision);
        },
        async activateRevision(revision) {
          activated.push(revision.id);
        },
        async stopRevision(revision) {
          stopped.push(revision.id);
        },
        async retireRevision(revision) {
          retired.push(revision.id);
        },
        async withdrawHarnessExposure(revision) {
          exposure.push(revision.id);
        },
      }));
    const state = workerState(fixture);
    const transactWithQueue = state.transactWithQueue.bind(state);
    state.transactWithQueue = async (work, options) => {
      // Admit the successor after the first candidate was prepared and authorized, but before
      // the Worker publishes its active pointer. Both revisions and Work rows are real OCC output.
      if (!pointerCommitPaused && preparedRevisionId !== undefined) {
        pointerCommitPaused = true;
        await allowPointerCommit.promise;
      }
      return transactWithQueue(work, options);
    };
    try {
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
      const predecessor = await controller.deployAgent(
        actorId,
        { namespaceId, agentId: owner.id },
        resolveApprovedHarness,
      );
      await waitFor("the first deployment to reach its pointer commit", () =>
        pointerCommitPaused ? true : undefined,
      );
      await controller.updateAgent(
        actorId,
        {
          namespaceId,
          agentId: owner.id,
          configurationId: owner.configurationId,
          harnessAuth: { method: "credential_source", sourceId: source.id },
          credentialSources: [{ sourceId: source.id }],
        },
        resolveApprovedHarness,
      );
      const successor = await controller.deployAgent(
        actorId,
        { namespaceId, agentId: owner.id },
        resolveApprovedHarness,
      );
      assert.equal(successor.executionAdmission.version, 8);
      allowPointerCommit.resolve();
      const successorWork = {
        id: successor.id,
        idempotencyKey: `agent_revision:${successor.id}:reconcile`,
      };
      await fixture.work(successorWork, "failed_permanent");
      await fixture.work(
        { id: predecessor.id, idempotencyKey: `agent_revision:${predecessor.id}:reconcile` },
        "succeeded",
      );
      assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, predecessor.id);
      assert.equal(
        (await fixture.workResult(successorWork)).rows[0]?.reason_code,
        "STAGED_CREDENTIAL_REPLACEMENT_UNSUPPORTED",
      );
      assert.deepEqual(prepared, [predecessor.id]);
      assert.deepEqual(activated, [predecessor.id]);
      assert.deepEqual(stopped, []);
      assert.deepEqual(retired, []);
      assert.equal(exposure.length, 0);

      await assert.rejects(
        controller.deployAgent(actorId, { namespaceId, agentId: owner.id }, resolveApprovedHarness),
        (error: unknown) =>
          error instanceof ResourceStateConflictError &&
          /staged managed credential is not supported/.test(error.message),
      );
      assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, predecessor.id);

      // Restart performs the normal failed-candidate exposure sweep. It may observe the active
      // revision's existing exposure, but must not withdraw the refused successor or stop/retire
      // the predecessor through candidate cleanup.
      await fixture.stop();
      const events: WorkerEvent[] = [];
      await startWorker((event) => events.push(event));
      const sweep = await waitFor("the restarted Worker's exposure sweep", () =>
        events.find((event) => event.event === "worker.harness-exposure-sweep"),
      );
      assert.equal(sweep.pending, 1);
      await waitFor("the active revision's routine exposure observation", () =>
        exposure.includes(predecessor.id) ? true : undefined,
      );
      assert.deepEqual(exposure, [predecessor.id]);
      assert.deepEqual(prepared, [predecessor.id]);
      assert.deepEqual(activated, [predecessor.id]);
      assert.deepEqual(stopped, []);
      assert.deepEqual(retired, []);
      assert.equal((await fixture.currentAgent(owner))?.activeRevisionId, predecessor.id);
    } finally {
      allowPointerCommit.resolve();
    }
  },
);
